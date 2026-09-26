import type { Room } from "colyseus.js";
import { sfuRequest } from "./rpc";
import type { VoiceTransport } from "./transport";

type Desc = { type: RTCSdpType; sdp: string };
const desc = (d: RTCSessionDescription | null): Desc => ({ type: d!.type, sdp: d!.sdp });

/** Espera a que termine de juntar candidatos ICE (el SFU no usa trickle), con tope. */
function gathered(pc: RTCPeerConnection, ms = 2500) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => { clearTimeout(t); pc.removeEventListener("icegatheringstatechange", check); resolve(); };
    const check = () => { if (pc.iceGatheringState === "complete") done(); };
    const t = setTimeout(done, ms);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

function connected(pc: RTCPeerConnection, ms = 10000) {
  if (pc.connectionState === "connected") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(t); pc.removeEventListener("connectionstatechange", check); };
    const check = () => {
      if (pc.connectionState === "connected") { stop(); resolve(); }
      else if (pc.connectionState === "failed" || pc.connectionState === "closed") { stop(); reject(new Error(`conexión ${pc.connectionState}`)); }
    };
    const t = setTimeout(() => { stop(); reject(new Error("no conectó en 10 s")); }, ms);
    pc.addEventListener("connectionstatechange", check);
  });
}

type Audible = { bodies: string[]; epoch: string };
type Remote = { audio: HTMLAudioElement; source: MediaStreamAudioSourceNode; analyser: AnalyserNode };

/**
 * Voz por Cloudflare Realtime SFU: cada jugador sube UNA pista (su voz modulada) y recibe las de los demás
 * por una sola conexión. El server de Colyseus hace las llamadas a la API con el secreto; aquí solo se maneja SDP.
 * Dos PeerConnections: `pub` (solo envía) y `sub` (solo recibe). Las operaciones de `sub` van en fila.
 */
export class VoiceSfu implements VoiceTransport {
  state: Record<string, RTCPeerConnectionState> = {};
  blocked = false;
  problem = "";
  onChange: () => void = () => {};

  private pub: RTCPeerConnection | null = null;
  private sub: RTCPeerConnection;
  private subscribed = false;
  // Qué voces hay que oír: lo decide el server. En partida las etiquetas son CUERPOS; si cambia el reparto
  // (o se pasa de cuerpos a personas) cambia la época y se re-suscribe todo.
  private pubs = new Set<string>();
  private epoch = "";
  private pulled = new Map<string, string>(); // etiqueta -> mid en `sub`
  private pidOfMid = new Map<string, string>();
  private remotes = new Map<string, Remote>();
  private retry = new Map<string, { n: number; at: number }>();
  private running = false;
  private stale = false;
  private again = false;
  private destroyed = false;
  private deaf = false;
  private buf = new Uint8Array(512);
  private unsub: () => void;

  constructor(private room: Room, private myId: string, private ctx: AudioContext, private track: MediaStreamTrack | null, private ice: RTCIceServer[]) {
    this.unsub = room.onMessage("sfuPubs", (a: Audible) => this.setAudible(a));
    this.sub = this.newPc("recepción");
    this.sub.ontrack = (e) => this.onTrack(e);
    this.sub.addEventListener("connectionstatechange", () => {
      const st = this.sub.connectionState;
      for (const id of this.pulled.keys()) this.state[id] = st;
      if (st === "failed") this.fail("Se cortó la conexión con el servidor de voz.");
      this.onChange();
    });
    void this.start();
  }

  private newPc(label: string) {
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: "max-bundle" });
    pc.addEventListener("connectionstatechange", () => {
      const st = pc.connectionState;
      (st === "failed" ? console.warn : console.info)(`[voz] SFU (${label}): ${st}`);
    });
    return pc;
  }

  private fail(message: string, e?: unknown) {
    if (this.destroyed) return;
    this.problem = message;
    console.warn(`[voz] ✖ ${message}`, e ?? "");
    this.onChange();
  }

  private async start() {
    console.info(`[voz] usando el SFU de Cloudflare (${this.track ? "hablo y escucho" : "solo escucho"})`);
    const publishing = this.track ? this.publish().catch((e) => this.fail(`No se pudo enviar tu voz: ${e?.message ?? e}`, e)) : null;
    try {
      const r = await sfuRequest<Audible>(this.room, "subscribe");
      if (this.destroyed) return;
      this.subscribed = true;
      this.setAudible(r);
    } catch (e: any) {
      this.fail(`No se pudo conectar con el servidor de voz: ${e?.message ?? e}`, e);
    }
    await publishing;
  }

  /** Publica la voz: oferta del navegador → answer del SFU → conectar → avisar que está lista. */
  private async publish() {
    const pc = (this.pub = this.newPc("envío"));
    const tr = pc.addTransceiver(this.track!, { direction: "sendonly", streams: [new MediaStream([this.track!])] });
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    const r = await sfuRequest<{ sdp: Desc }>(this.room, "publish", { sdp: desc(pc.localDescription), mid: tr.mid });
    if (this.destroyed) return;
    await pc.setRemoteDescription(r.sdp);
    await connected(pc);
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") this.fail("Se cortó el envío de tu voz al servidor.");
    });
    if (this.destroyed) return;
    await sfuRequest(this.room, "ready");
    console.info("[voz] ✔ tu voz está publicada en el SFU");
  }

  /** Con el SFU decide el server a quién se oye; esto no hace falta. */
  sync(_ids: string[]) {}

  private setAudible(a: Audible) {
    if (!a || !Array.isArray(a.bodies)) return;
    if (a.epoch !== this.epoch) {
      this.epoch = a.epoch;
      this.stale = true; // las etiquetas viejas ya no significan lo mismo
      this.retry.clear();
    }
    this.pubs = new Set(a.bodies);
    this.reconcile();
  }

  /** Ajusta las suscripciones a (publicados ∩ buscados). Una sola a la vez; si llegan cambios, se repite. */
  private reconcile() {
    if (!this.subscribed || this.destroyed) return;
    if (this.running) { this.again = true; return; }
    this.running = true;
    void (async () => {
      try {
        do {
          this.again = false;
          await this.step();
        } while (this.again && !this.destroyed);
        if (this.problem.startsWith("Reintentando")) { this.problem = ""; this.onChange(); }
      } catch (e: any) {
        // Suele ser una demora de la API: reintentar solo.
        this.fail(`Reintentando conectar las voces… (${e?.message ?? e})`, e);
        setTimeout(() => this.reconcile(), 3000);
      } finally {
        this.running = false;
      }
    })();
  }

  private async step() {
    const want = [...this.pubs];
    const gone = [...this.pulled].filter(([id]) => this.stale || !want.includes(id));
    this.stale = false;
    if (gone.length) {
      await sfuRequest(this.room, "close", { mids: gone.map(([, mid]) => mid) });
      for (const [id, mid] of gone) {
        this.pulled.delete(id);
        this.pidOfMid.delete(mid);
        this.dropRemote(id);
        delete this.state[id];
      }
      this.onChange();
    }
    const now = Date.now();
    const pull = want.filter((id) => !this.pulled.has(id) && (this.retry.get(id)?.at ?? 0) <= now);
    if (!pull.length || this.destroyed) return;
    for (const id of pull) this.state[id] ??= "connecting";
    const r = await sfuRequest<{ tracks: { pid: string; mid?: string; error?: string }[]; sdp?: Desc }>(this.room, "pull", { pids: pull });
    for (const id of pull) if (!r.tracks.some((t) => t.pid === id)) delete this.state[id]; // aún no estaba lista
    for (const t of r.tracks) {
      if (t.error || !t.mid) {
        // Suele ser que su audio todavía no llegó al SFU: reintentar con espera creciente.
        const n = (this.retry.get(t.pid)?.n ?? 0) + 1;
        const wait = Math.min(10000, 1500 * n);
        this.retry.set(t.pid, { n, at: Date.now() + wait });
        this.state[t.pid] = n >= 5 ? "failed" : "connecting";
        console.warn(`[voz] no se pudo recibir a ${this.name(t.pid)} (${t.error ?? "sin mid"}), reintento ${n}`);
        setTimeout(() => this.reconcile(), wait + 50);
      } else {
        this.pulled.set(t.pid, t.mid);
        this.pidOfMid.set(t.mid, t.pid);
        this.retry.delete(t.pid);
      }
    }
    console.debug(`[voz] DEBUGPULL epoch=${this.epoch} pedidos=${pull.join(",")} → ${JSON.stringify(r.tracks)} sdpType=${r.sdp?.type}`);
    if (r.sdp) {
      await this.sub.setRemoteDescription(r.sdp);
      await this.sub.setLocalDescription();
      await gathered(this.sub);
      await sfuRequest(this.room, "renegotiate", { sdp: desc(this.sub.localDescription) });
    }
    this.onChange();
  }

  private onTrack(e: RTCTrackEvent) {
    const pid = this.pidOfMid.get(e.transceiver.mid ?? "");
    if (!pid) return console.warn("[voz] llegó una pista sin dueño conocido", e.transceiver.mid, "DEBUGMAP", JSON.stringify([...this.pidOfMid]));
    this.dropRemote(pid);
    const stream = new MediaStream([e.track]);
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    audio.muted = this.deaf;
    audio.style.display = "none";
    audio.srcObject = stream;
    document.body.appendChild(audio);
    this.play(audio);
    // En Chrome el stream remoto tiene que estar también en un <audio>: si no, Web Audio no recibe muestras.
    const source = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    this.remotes.set(pid, { audio, source, analyser });
    this.state[pid] = this.sub.connectionState === "connected" ? "connected" : "connecting";
    console.info(`[voz] ✔ recibiendo la voz de ${this.name(pid)}`);
    this.onChange();
  }

  private dropRemote(pid: string) {
    const r = this.remotes.get(pid);
    if (!r) return;
    this.remotes.delete(pid);
    r.source.disconnect();
    r.audio.srcObject = null;
    r.audio.remove();
  }

  private play(audio: HTMLAudioElement) {
    audio.play().catch((e) => {
      console.warn("[voz] el navegador bloqueó el audio hasta un toque:", e?.name ?? e);
      this.blocked = true;
      this.onChange();
    });
  }

  private name(id: string) {
    return (this.room.state as any)?.players?.get?.(id)?.name ?? id;
  }

  deafen(on: boolean) {
    this.deaf = on;
    for (const r of this.remotes.values()) r.audio.muted = on;
  }

  unblock() {
    this.blocked = false;
    void this.ctx.resume();
    for (const r of this.remotes.values()) this.play(r.audio);
    this.onChange();
  }

  levels() {
    const out: Record<string, number> = {};
    for (const [id, r] of this.remotes) {
      r.analyser.getByteTimeDomainData(this.buf);
      let peak = 0;
      for (const v of this.buf) peak = Math.max(peak, Math.abs(v - 128));
      out[id] = peak / 128;
    }
    return out;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsub();
    // El server cierra la publicación; si ya salimos del lobby, igual la olvida él solo.
    try { this.room.send("sfu", { op: "leave" }); } catch {}
    for (const id of [...this.remotes.keys()]) this.dropRemote(id);
    this.pub?.close();
    this.sub.close();
  }
}

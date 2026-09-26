import type { Room } from "colyseus.js";
import type { VoiceTransport } from "./transport";

/** STUN público por defecto; `VITE_ICE_SERVERS` (JSON, RTCIceServer[]) para poner un TURN propio. */
function iceServers(): RTCIceServer[] {
  const raw = import.meta.env.VITE_ICE_SERVERS as string | undefined;
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
    } catch {
      console.warn("[voz] VITE_ICE_SERVERS no es JSON válido");
    }
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

const ICE = iceServers();
const hasTurn = ICE.some((s) => [s.urls].flat().some((u) => /^turns?:/.test(u)));

/** Tipo de un candidato ICE (host = red local, srflx = IP pública vía STUN, relay = TURN). */
const candType = (c: RTCIceCandidateInit | RTCIceCandidate) =>
  ("type" in c && c.type) || / typ (\w+)/.exec(c.candidate ?? "")?.[1] || "?";
const countTypes = (list: string[]) =>
  Object.entries(list.reduce<Record<string, number>>((m, t) => ({ ...m, [t]: (m[t] ?? 0) + 1 }), {}))
    .map(([t, n]) => `${t}×${n}`).join(" ") || "ninguno";

/** `s` = sesión de la malla que envía, `t` = sesión del destinatario (para descartar señales viejas). */
type Signal = {
  s: string; t?: string;
  hello?: true; ack?: true;
  description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null;
};

type Peer = {
  id: string;
  remote: string; // sesión de la malla del otro lado
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  queue: Promise<void>; // las señales se procesan de a una, en orden
  audio: HTMLAudioElement;
  analyser: AnalyserNode | null;
  source: MediaStreamAudioSourceNode | null;
  localTypes: string[]; // tipos de candidatos ICE propios y del otro, para diagnosticar fallos
  remoteTypes: string[];
};

/**
 * Malla P2P del lobby: un RTCPeerConnection por cada otro jugador en la voz.
 * Señalización por el WS de Colyseus (mensaje "rtc"). Patrón "perfect negotiation" de MDN: polite = el id menor.
 *
 * Cada malla tiene una sesión al azar. El RTCPeerConnection se crea recién cuando se conoce la sesión del otro:
 * - al ver a alguien nuevo se le manda `hello`; quien lo recibe descarta cualquier conexión vieja con nosotros,
 *   crea una nueva y contesta `hello + ack`, y con eso el primero crea la suya;
 * - toda otra señal lleva `s` y `t`, y se descarta si no coincide con las sesiones actuales (era para una malla vieja).
 * Así no importa si el otro todavía no tenía la malla armada cuando le escribimos: al armarla nos manda su `hello`.
 */
export class VoiceMesh implements VoiceTransport {
  private peers = new Map<string, Peer>();
  private unsub: () => void;
  private out: GainNode; // la voz de los demás suena por aquí (Web Audio), no por los <audio>
  private buf = new Uint8Array(512);
  private stream: MediaStream | null;
  private destroyed = false;
  private session = Math.random().toString(36).slice(2, 10);
  private wanted = new Set<string>();
  /** Estado de cada conexión. */
  state: Record<string, RTCPeerConnectionState> = {};
  /** Algún <audio> no pudo arrancar sin un toque (Safari/iOS). */
  blocked = false;
  problem = "";
  onChange: () => void = () => {};

  constructor(private room: Room, private myId: string, private ctx: AudioContext, private track: MediaStreamTrack | null) {
    this.stream = track ? new MediaStream([track]) : null;
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    console.info(`[voz] malla P2P · ICE: ${ICE.map((s) => [s.urls].flat().join(",")).join(" · ")}${hasTurn ? "" : " (sin TURN)"}`);
    this.unsub = room.onMessage("rtc", ({ from, data }: { from: string; data: Signal }) => this.onSignal(from, data));
  }

  /**
   * Saluda a los ids nuevos de la lista y cierra a los que salieron de ella. No cierra a quien nos saludó sin estar
   * todavía en la lista: su `hello` puede llegar antes que el cambio de estado que lo anuncia.
   */
  sync(ids: string[]) {
    if (this.destroyed) return;
    const want = new Set(ids.filter((id) => id !== this.myId));
    for (const id of this.wanted) if (!want.has(id)) this.close(id);
    for (const id of want) {
      if (!this.wanted.has(id) && !this.peers.has(id)) this.room.send("rtc", { to: id, data: { s: this.session, hello: true } });
    }
    this.wanted = want;
  }

  /** Ensordecer: silencia todo lo que llega. */
  deafen(on: boolean) {
    this.out.gain.value = on ? 0 : 1;
  }

  /** Reintenta reproducir los <audio> bloqueados (llamar desde un toque). */
  unblock() {
    this.blocked = false;
    void this.ctx.resume();
    for (const p of this.peers.values()) if (p.audio.srcObject) this.play(p.audio);
    this.onChange();
  }

  /** Nivel (0–1) que llega de cada peer. */
  levels() {
    const out: Record<string, number> = {};
    for (const [id, p] of this.peers) {
      if (!p.analyser) continue;
      p.analyser.getByteTimeDomainData(this.buf);
      let peak = 0;
      for (const v of this.buf) peak = Math.max(peak, Math.abs(v - 128));
      out[id] = peak / 128;
    }
    return out;
  }

  destroy() {
    this.destroyed = true;
    this.unsub();
    for (const id of [...this.peers.keys()]) this.close(id);
    this.out.disconnect();
  }

  // ---------------- internos ----------------

  private send(peer: Peer, data: Omit<Signal, "s" | "t">) {
    this.room.send("rtc", { to: peer.id, data: { ...data, s: this.session, t: peer.remote } });
  }

  private name(id: string) {
    return (this.room.state as any)?.players?.get?.(id)?.name ?? id;
  }

  /** Al fallar: qué candidatos hubo de cada lado y, si se puede, por qué. */
  private async diagnose(peer: Peer) {
    const who = this.name(peer.id);
    const mine = countTypes(peer.localTypes);
    const theirs = countTypes(peer.remoteTypes);
    let pairs = "";
    try {
      const stats = await peer.pc.getStats();
      const states: string[] = [];
      stats.forEach((r: any) => { if (r.type === "candidate-pair") states.push(r.state); });
      pairs = ` · pares ICE: ${countTypes(states)}`;
    } catch {}
    const hint = hasTurn
      ? "Revisa que el TURN responda (usuario/clave)."
      : "Sin TURN: si alguno está en 4G/CGNAT/red corporativa no hay ruta directa. Configura VITE_ICE_SERVERS con un TURN.";
    console.warn(`[voz] ✖ no se pudo conectar con ${who}. Candidatos míos: ${mine} · suyos: ${theirs}${pairs}. ${hint}`);
  }

  private open(id: string, remote: string) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    audio.muted = true; // suena por Web Audio (ver VoiceSfu.onTrack)
    audio.style.display = "none";
    document.body.appendChild(audio);
    const peer: Peer = {
      id, remote, pc, polite: this.myId < id, makingOffer: false, ignoreOffer: false, queue: Promise.resolve(), audio, analyser: null, source: null,
      localTypes: [], remoteTypes: [],
    };
    const who = this.name(id);
    console.info(`[voz] conectando con ${who} (${peer.polite ? "polite" : "impolite"})`);
    this.peers.set(id, peer);
    this.state[id] = pc.connectionState;

    // Solo la voz procesada: nunca la pista del micrófono.
    if (this.track && this.stream) pc.addTrack(this.track, this.stream);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) this.send(peer, { description: pc.localDescription.toJSON() });
      } catch (e) {
        console.warn(`[voz] error al ofertar a ${who}:`, e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) peer.localTypes.push(candType(candidate));
      else console.info(`[voz] candidatos para ${who}: ${countTypes(peer.localTypes)}`);
      this.send(peer, { candidate: candidate ? candidate.toJSON() : null });
    };
    pc.oniceconnectionstatechange = () => console.info(`[voz] ICE con ${who}: ${pc.iceConnectionState}`);
    pc.onconnectionstatechange = () => {
      this.state[id] = pc.connectionState;
      const st = pc.connectionState;
      if (st === "failed") void this.diagnose(peer);
      else (st === "connected" ? console.info : console.debug)(`[voz] ${st === "connected" ? "✔ " : ""}conexión con ${who}: ${st}`);
      this.onChange();
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] ?? new MediaStream([track]);
      audio.srcObject = stream;
      this.play(audio);
      // En Chrome el stream remoto tiene que estar también en un <audio>: si no, Web Audio no recibe muestras.
      peer.source?.disconnect();
      peer.source = this.ctx.createMediaStreamSource(stream);
      peer.analyser = this.ctx.createAnalyser();
      peer.analyser.fftSize = 512;
      peer.source.connect(peer.analyser);
      peer.source.connect(this.out);
    };
    this.onChange();
    return peer;
  }

  private close(id: string) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    delete this.state[id];
    p.pc.onnegotiationneeded = p.pc.onicecandidate = p.pc.onconnectionstatechange = p.pc.oniceconnectionstatechange = p.pc.ontrack = null;
    p.pc.close();
    p.source?.disconnect();
    p.audio.srcObject = null;
    p.audio.remove();
    this.onChange();
  }

  private play(audio: HTMLAudioElement) {
    audio.play().catch((e) => {
      console.warn("[voz] el navegador bloqueó el audio hasta un toque:", e?.name ?? e);
      this.blocked = true;
      this.onChange();
    });
  }

  private onSignal(from: string, data: Signal) {
    if (this.destroyed || !data || typeof data.s !== "string" || from === this.myId) return;
    const peer = this.peers.get(from);
    if (data.hello && !data.ack) {
      // El otro (re)arrancó su malla: empezamos de cero con él y le contestamos.
      this.close(from);
      const fresh = this.open(from, data.s);
      this.send(fresh, { hello: true, ack: true });
      return;
    }
    if (data.t !== this.session) return; // iba para una malla nuestra anterior
    if (data.hello) {
      if (peer?.remote === data.s) return; // ya estamos conectando con esa sesión
      this.close(from);
      this.open(from, data.s);
      return;
    }
    if (!peer || peer.remote !== data.s) return; // de una malla vieja del otro
    peer.queue = peer.queue.then(() => this.handle(peer, data)).catch((e) => console.warn(`[voz] error con la señal de ${this.name(from)}:`, e));
  }

  private async handle(peer: Peer, { description, candidate }: Signal) {
    const { pc } = peer;
    if (pc.signalingState === "closed") return;
    if (description) {
      const collision = description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(description); // con colisión, el polite hace rollback implícito
      if (description.type === "offer") {
        await pc.setLocalDescription();
        if (pc.localDescription) this.send(peer, { description: pc.localDescription.toJSON() });
      }
    } else if (candidate !== undefined) {
      if (candidate) peer.remoteTypes.push(candType(candidate));
      try {
        await pc.addIceCandidate(candidate ?? undefined);
      } catch (e) {
        if (!peer.ignoreOffer) throw e;
      }
    }
  }
}

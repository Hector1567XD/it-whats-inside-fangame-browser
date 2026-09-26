import type { Room } from "colyseus.js";

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
export class VoiceMesh {
  private peers = new Map<string, Peer>();
  private unsub: () => void;
  private deaf = false;
  private buf = new Uint8Array(512);
  private stream: MediaStream | null;
  private destroyed = false;
  private session = Math.random().toString(36).slice(2, 10);
  private wanted = new Set<string>();
  /** Estado de cada conexión. */
  state: Record<string, RTCPeerConnectionState> = {};
  /** Algún <audio> no pudo arrancar sin un toque (Safari/iOS). */
  blocked = false;
  onChange: () => void = () => {};

  constructor(private room: Room, private myId: string, private ctx: AudioContext, private track: MediaStreamTrack | null) {
    this.stream = track ? new MediaStream([track]) : null;
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
    this.deaf = on;
    for (const p of this.peers.values()) p.audio.muted = on;
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
  }

  // ---------------- internos ----------------

  private send(peer: Peer, data: Omit<Signal, "s" | "t">) {
    this.room.send("rtc", { to: peer.id, data: { ...data, s: this.session, t: peer.remote } });
  }

  private open(id: string, remote: string) {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    audio.muted = this.deaf;
    audio.style.display = "none";
    document.body.appendChild(audio);
    const peer: Peer = {
      id, remote, pc, polite: this.myId < id, makingOffer: false, ignoreOffer: false, queue: Promise.resolve(), audio, analyser: null, source: null,
    };
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
        console.warn("[voz] oferta", e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => this.send(peer, { candidate: candidate ? candidate.toJSON() : null });
    pc.onconnectionstatechange = () => {
      this.state[id] = pc.connectionState;
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
    };
    this.onChange();
    return peer;
  }

  private close(id: string) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    delete this.state[id];
    p.pc.onnegotiationneeded = p.pc.onicecandidate = p.pc.onconnectionstatechange = p.pc.ontrack = null;
    p.pc.close();
    p.source?.disconnect();
    p.audio.srcObject = null;
    p.audio.remove();
    this.onChange();
  }

  private play(audio: HTMLAudioElement) {
    audio.play().catch(() => {
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
    peer.queue = peer.queue.then(() => this.handle(peer, data)).catch((e) => console.warn("[voz] señal", e));
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
      try {
        await pc.addIceCandidate(candidate ?? undefined);
      } catch (e) {
        if (!peer.ignoreOffer) throw e;
      }
    }
  }
}

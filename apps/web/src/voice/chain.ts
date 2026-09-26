import { buildEngine, pickEngine, Links, type Engine, type EngineId } from "./engines";
import type { VoiceParams } from "./presets";

export type WalkieLevel = 0 | 1 | 2;

/**
 * input → motor de tono → timbre (lowshelf + highshelf) → walkie → compresor → out.
 * Se usa para la voz en vivo (out = MediaStreamDestination) y para "escúchate" (out = altavoces).
 * Cambiar el walkie reconecta los nodos intermedios: `out` sigue siendo el mismo, así no se renegocia el WebRTC.
 */
class Pipeline {
  private post: GainNode;
  private low: BiquadFilterNode;
  private high: BiquadFilterNode;
  private comp: DynamicsCompressorNode;
  private walkieLinks = new Links();
  private engine: Engine | null = null;
  engineId: EngineId | null = null;
  failed: { id: EngineId; error: string }[] = [];

  constructor(private ctx: AudioContext, private input: AudioNode, out: AudioNode) {
    this.post = ctx.createGain();
    this.low = ctx.createBiquadFilter();
    this.low.type = "lowshelf";
    this.low.frequency.value = 300;
    this.high = ctx.createBiquadFilter();
    this.high.type = "highshelf";
    this.high.frequency.value = 2800;
    this.comp = ctx.createDynamicsCompressor();
    this.post.connect(this.low);
    this.low.connect(this.high);
    this.comp.connect(out);
  }

  /** Con `engineId` prueba primero ese motor; si no, o si falla, prueba en orden y se queda con el primero que funcione. */
  async start(p: VoiceParams, walkie: WalkieLevel, engineId?: EngineId) {
    this.setTilt(p.tilt);
    this.setWalkie(walkie);
    if (engineId) {
      try {
        this.engine = await buildEngine(engineId, this.ctx, this.input, this.post, p);
        this.engineId = engineId;
        return;
      } catch (e) {
        console.warn(`[voz] el motor ${engineId} dejó de funcionar:`, e);
      }
    }
    const r = await pickEngine(this.ctx, this.input, this.post, p);
    Object.assign(this, { engine: r.engine, engineId: r.id, failed: r.failed });
  }

  setParams(p: VoiceParams) {
    this.setTilt(p.tilt);
    this.engine?.set(p);
  }

  private setTilt(t: number) {
    this.low.gain.value = -t * 0.7;
    this.high.gain.value = t;
  }

  setWalkie(level: WalkieLevel) {
    const ctx = this.ctx;
    this.walkieLinks.clear();
    try { this.high.disconnect(); } catch {}
    const L = this.walkieLinks;
    if (level === 0) return L.link(this.high, this.comp);
    const [hpHz, lpHz, drive] = level === 1 ? [300, 3400, 1.5] : [500, 2600, 4];
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = hpHz;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = lpHz;
    const sh = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) curve[i] = Math.tanh(drive * (i / 511.5 - 1)) / Math.tanh(drive);
    sh.curve = curve;
    L.link(this.high, hp);
    L.link(hp, lp);
    L.link(lp, sh);
    L.link(sh, this.comp);
    if (level === 2) {
      // un poco de estática de fondo, a −35 dB
      const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = nb.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = nb;
      noise.loop = true;
      const nhp = ctx.createBiquadFilter();
      nhp.type = "highpass";
      nhp.frequency.value = 800;
      const ng = ctx.createGain();
      ng.gain.value = Math.pow(10, -35 / 20);
      L.link(noise, nhp);
      L.link(nhp, ng);
      L.link(ng, this.comp);
      noise.start();
      L.own(noise);
    }
  }

  stop() {
    this.engine?.stop();
    this.engine = null;
    this.walkieLinks.clear();
    for (const n of [this.post, this.low, this.high, this.comp]) try { n.disconnect(); } catch {}
  }
}

/**
 * La voz de quien habla, en su propio navegador. Al peer se le manda SOLO `outputTrack` (la voz procesada):
 * la pista del micrófono nunca sale del dispositivo.
 */
export class VoiceChain {
  private micSrc: MediaStreamAudioSourceNode;
  private dest: MediaStreamAudioDestinationNode;
  private live: Pipeline | null = null;
  private preview: { src: AudioBufferSourceNode; pipe: Pipeline } | null = null;
  private analyser: AnalyserNode;
  private buf = new Uint8Array(512);
  private walkie: WalkieLevel = 0;
  engineId: EngineId | null = null;
  failed: { id: EngineId; error: string }[] = [];

  private constructor(readonly ctx: AudioContext, private mic: MediaStream) {
    this.micSrc = ctx.createMediaStreamSource(mic);
    this.dest = ctx.createMediaStreamDestination();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
  }

  /** Pide el micrófono (una sola vez por sesión de lobby). Llamar desde un gesto del usuario. */
  static async open(ctx: AudioContext, engineId: EngineId | null = null) {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const chain = new VoiceChain(ctx, mic);
    chain.engineId = engineId; // el que funcionó la vez anterior: no volver a esperar a los que fallan
    return chain;
  }

  /** La voz procesada que va a los peers. */
  get outputTrack() {
    return this.dest.stream.getAudioTracks()[0];
  }

  /** Arranca la voz en vivo (mic → cadena → MediaStreamDestination). */
  async start(p: VoiceParams, walkie: WalkieLevel) {
    this.walkie = walkie;
    if (this.live) return this.live.setParams(p);
    const out = this.ctx.createGain();
    out.connect(this.dest);
    out.connect(this.analyser);
    const pipe = new Pipeline(this.ctx, this.micSrc, out);
    await pipe.start(p, walkie, this.engineId ?? undefined);
    this.live = pipe;
    this.engineId = pipe.engineId;
    if (pipe.failed.length) this.failed = pipe.failed;
  }

  setParams(p: VoiceParams) {
    this.live?.setParams(p);
  }

  setWalkie(level: WalkieLevel) {
    if (level === this.walkie) return;
    this.walkie = level;
    this.live?.setWalkie(level);
  }

  /** Mute: apaga la pista enviada, sin soltar el micrófono. */
  setMuted(muted: boolean) {
    const t = this.outputTrack;
    if (t) t.enabled = !muted;
  }

  /** Nivel (0–1) de la voz procesada, para el anillo de "hablando". */
  level() {
    if (!this.live) return 0;
    this.analyser.getByteTimeDomainData(this.buf);
    let peak = 0;
    for (const v of this.buf) peak = Math.max(peak, Math.abs(v - 128));
    return peak / 128;
  }

  /** Graba el micrófono crudo (solo local, para calibrar el tono). */
  async record(ms: number) {
    const rec = new MediaRecorder(this.mic);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start();
    await new Promise((r) => setTimeout(r, ms));
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    const blob = new Blob(chunks, { type: rec.mimeType });
    return this.ctx.decodeAudioData(await blob.arrayBuffer());
  }

  /** "Escúchate": reproduce una grabación ya modulada por los altavoces locales (nunca por el peer). */
  async previewBuffer(buffer: AudioBuffer, p: VoiceParams, walkie: WalkieLevel) {
    this.stopPreview();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const pipe = new Pipeline(this.ctx, src, this.ctx.destination);
    await pipe.start(p, walkie, this.engineId ?? undefined);
    if (!this.engineId) {
      this.engineId = pipe.engineId;
      this.failed = pipe.failed;
    }
    this.preview = { src, pipe };
    await this.ctx.resume();
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      src.start();
    });
    if (this.preview?.src === src) this.stopPreview();
  }

  stopPreview() {
    if (!this.preview) return;
    try { this.preview.src.stop(); } catch {}
    this.preview.pipe.stop();
    this.preview = null;
  }

  destroy() {
    this.stopPreview();
    this.live?.stop();
    this.live = null;
    this.micSrc.disconnect();
    this.dest.stream.getTracks().forEach((t) => t.stop());
    this.mic.getTracks().forEach((t) => t.stop());
  }
}

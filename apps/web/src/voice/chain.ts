import { buildEngine, pickEngine, Links, type Engine, type EngineId } from "./engines";
import type { VoiceParams } from "./presets";
import { detectF0Live } from "./pitch";

/** 📻 0 = off · 1 = poquito · 2 = distorsión (sin estática) · 3 = radio (estática solo mientras hablas). */
export type WalkieLevel = 0 | 1 | 2 | 3;
export const WALKIE_LABELS = ["Off", "Poquito", "Distorsión", "Radio"];

const curveOf = (fn: (x: number) => number, n = 1024) => {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  return c;
};

/**
 * 🎚️ Aplanar entonación: la voz sale en `objetivo + (f0 − media) · K`. Con K = 0,5 las subidas y bajadas de tono
 * quedan a la mitad (se parecen más entre personas); 1 = natural, 0 = monótono. Solo con motores que cambian
 * el tono en vivo sin cortes; el resto se queda con el corrimiento fijo.
 */
const FLATTEN_K = 0.5;
const FLATTEN_ENGINES: EngineId[] = ["signalsmith", "tone"];
const TICK_MS = 25; // ~40 mediciones por segundo
const toSemi = (hz: number) => 12 * Math.log2(hz / 55);

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
  // Aplanar entonación
  private params: VoiceParams | null = null;
  private pitchAn: AnalyserNode;
  private pitchBuf = new Float32Array(2048);
  private pitchTimer: ReturnType<typeof setInterval> | undefined;
  private med: number[] = []; // últimos 3 tonos (mediana)
  private mean: number | null = null; // media del tono de quien habla (~4 s), en semitonos
  private shift = 0; // corrimiento actual, en semitonos
  private sent = NaN;

  constructor(private ctx: AudioContext, private input: AudioNode, out: AudioNode) {
    this.pitchAn = ctx.createAnalyser();
    this.pitchAn.fftSize = 2048;
    input.connect(this.pitchAn);
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
    this.params = p;
    this.shift = p.semitones;
    if (engineId) {
      try {
        this.engine = await buildEngine(engineId, this.ctx, this.input, this.post, p);
        this.engineId = engineId;
        return this.startFlatten();
      } catch (e) {
        console.warn(`[voz] el motor ${engineId} dejó de funcionar:`, e);
      }
    }
    const r = await pickEngine(this.ctx, this.input, this.post, p);
    Object.assign(this, { engine: r.engine, engineId: r.id, failed: r.failed });
    this.startFlatten();
  }

  setParams(p: VoiceParams) {
    this.setTilt(p.tilt);
    this.params = p;
    if (this.pitchTimer) this.sent = NaN; // el próximo cuadro lo manda con el objetivo nuevo
    else this.engine?.set(p);
  }

  private startFlatten() {
    clearInterval(this.pitchTimer);
    if (!this.engineId || !FLATTEN_ENGINES.includes(this.engineId)) return;
    this.pitchTimer = setInterval(() => this.flattenTick(), TICK_MS);
  }

  /** Un cuadro: mide el tono de quien habla y ajusta el corrimiento para que salga más plano. */
  private flattenTick() {
    const p = this.params;
    if (!p || !this.engine) return;
    this.pitchAn.getFloatTimeDomainData(this.pitchBuf);
    const f0 = detectF0Live(this.pitchBuf, this.ctx.sampleRate);
    let s: number | null = f0 ? toSemi(f0) : null;
    if (s !== null) {
      this.med.push(s);
      if (this.med.length > 3) this.med.shift();
      s = [...this.med].sort((a, b) => a - b)[Math.floor(this.med.length / 2)];
      if (this.mean !== null && Math.abs(s - this.mean) > 10) s = null; // salto raro: probable error de octava
    }
    if (s !== null) {
      // La media arranca en el tono calibrado del jugador y se va ajustando (~4 s).
      this.mean ??= toSemi(p.f0);
      this.mean += (s - this.mean) * (TICK_MS / 1000 / 4);
      const target = toSemi(p.f0) + p.semitones; // tono de la voz del cuerpo
      const out = target + (s - this.mean) * FLATTEN_K;
      const want = Math.min(12, Math.max(-12, out - s));
      this.shift += (want - this.shift) * 0.6;
    }
    // Sin voz se mantiene el último corrimiento.
    const semis = Math.round(this.shift * 20) / 20;
    if (semis === this.sent) return;
    this.sent = semis;
    this.engine.set({ ...p, semitones: semis });
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
    // Los mismos valores que mockups/voz-7.html (ⓕ Walkie).
    const biquad = (type: BiquadFilterType, hz: number, q: number) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = hz;
      b.Q.value = q;
      return b;
    };
    const shaper = (fn: (x: number) => number) => {
      const sh = ctx.createWaveShaper();
      sh.curve = curveOf(fn);
      return sh;
    };
    const gain = (v: number) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    // Poquito: pasa-banda 300–3.400 Hz. Distorsión y Radio: 500–2.600 Hz + saturación.
    const [hpHz, lpHz, drive] = level === 1 ? [300, 3400, 0] : [500, 2600, 4];
    const hp = biquad("highpass", hpHz, 0.9);
    const lp = biquad("lowpass", lpHz, 0.9);
    L.link(this.high, hp);
    L.link(hp, lp);
    let last: AudioNode = lp;
    if (drive) {
      const sh = shaper((x) => Math.tanh(drive * x) / Math.tanh(drive));
      const post = gain(0.8);
      L.link(lp, sh);
      L.link(sh, post);
      last = post;
    }
    L.link(last, this.comp);
    if (level === 3) {
      // Estática que suena SOLO mientras hablas: |voz| → pasa-bajos 15 Hz → ×12 → umbral → ganancia del ruido.
      // La ganancia base del ruido es 0: en silencio no hay siseo.
      const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = nb.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = nb;
      noise.loop = true;
      const rect = shaper(Math.abs);
      const env = biquad("lowpass", 15, 0.7);
      const sens = gain(12);
      const gate = shaper((x) => Math.min(1, Math.max(0, (x - 0.12) / 0.4)));
      const nhp = biquad("highpass", 900, 0.7);
      const nlp = biquad("lowpass", 5500, 0.7);
      const staticLevel = gain(Math.pow(10, -24 / 20)); // −24 dB
      const noiseGain = gain(0);
      L.link(this.high, rect);
      L.link(rect, env);
      L.link(env, sens);
      L.link(sens, gate);
      L.link(gate, noiseGain.gain);
      L.link(noise, nhp);
      L.link(nhp, nlp);
      L.link(nlp, staticLevel);
      L.link(staticLevel, noiseGain);
      L.link(noiseGain, this.comp);
      noise.start();
      L.own(noise);
    }
  }

  stop() {
    clearInterval(this.pitchTimer);
    this.pitchTimer = undefined;
    try { this.input.disconnect(this.pitchAn); } catch {}
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

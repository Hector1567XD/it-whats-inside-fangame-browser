import type { VoiceParams } from "./presets";

/**
 * Motores de cambio de voz, del más natural al último recurso. Todos tienen la misma interfaz:
 * `build(ctx, input, output, params)` conecta input → motor → output y devuelve cómo ajustarlo y pararlo.
 * Portado de mockups/voz-v5.html.
 */
export type EngineId = "signalsmith" | "tone" | "native" | "robot";
export type Engine = { set(p: VoiceParams): void; stop(): void };
type Builder = (ctx: AudioContext, input: AudioNode, output: AudioNode, p: VoiceParams) => Promise<Engine>;

export const ENGINE_ORDER: EngineId[] = ["signalsmith", "tone", "native", "robot"];
export const ENGINE_LABELS: Record<EngineId, string> = {
  signalsmith: "Signalsmith", tone: "Tone.js", native: "Nativo", robot: "Robot",
};
const TIMEOUT_MS = 5000;

// `?voiceEngine=` para pruebas. Se lee al cargar: al entrar a una sala la URL pasa a ser `?room=…`.
const FORCED_KEY = "lqha:voiceEngine";
const fromUrl = new URLSearchParams(location.search).get("voiceEngine");
try {
  if (fromUrl) sessionStorage.setItem(FORCED_KEY, fromUrl);
} catch {}
export function forcedEngine(): EngineId | null {
  let v = fromUrl;
  try { v ??= sessionStorage.getItem(FORCED_KEY); } catch {}
  return v && (ENGINE_ORDER as string[]).includes(v) ? (v as EngineId) : null;
}

/** Guarda las conexiones para poder deshacerlas sin tocar las de otros. */
export class Links {
  private list: [AudioNode, AudioNode | AudioParam][] = [];
  private sources: AudioScheduledSourceNode[] = [];
  link(a: AudioNode, b: AudioNode | AudioParam) {
    a.connect(b as AudioNode);
    this.list.push([a, b]);
  }
  own(s: AudioScheduledSourceNode) {
    this.sources.push(s);
  }
  clear() {
    for (const [a, b] of this.list) try { a.disconnect(b as AudioNode); } catch {}
    for (const s of this.sources) try { s.stop(); } catch {}
    this.list = [];
    this.sources = [];
  }
}

// ---- 1. Signalsmith Stretch (WASM + AudioWorklet): tono y formantes por separado ----
const signalsmith: Builder = async (ctx, input, output, p) => {
  if (!ctx.audioWorklet) throw new Error("Este navegador no tiene AudioWorklet");
  const { default: SignalsmithStretch } = await import("signalsmith-stretch");
  const node = await SignalsmithStretch(ctx);
  const set = (q: VoiceParams) => node.schedule({
    active: true, semitones: q.semitones, formantSemitones: q.formant, formantCompensation: true, formantBaseHz: q.f0,
  });
  await set(p);
  input.connect(node);
  node.connect(output);
  return {
    set: (q) => void set(q),
    stop: () => {
      try { input.disconnect(node); } catch {}
      node.disconnect();
      void node.schedule({ active: false });
    },
  };
};

// ---- 2. Tone.js PitchShift (delay-lines, sin worklet) ----
const tone: Builder = async (ctx, input, output, p) => {
  const Tone = await import("tone");
  if (Tone.getContext().rawContext !== ctx) Tone.setContext(ctx);
  const ps = new Tone.PitchShift({ pitch: p.semitones, windowSize: 0.08 });
  const inG = ctx.createGain();
  input.connect(inG);
  Tone.connect(inG, ps);
  ps.connect(output);
  return {
    set: (q) => { ps.pitch = q.semitones; },
    stop: () => {
      try { input.disconnect(inG); } catch {}
      inG.disconnect();
      ps.dispose();
    },
  };
};

// ---- 3. Nativo: dos líneas de retardo con rampa de sierra y ventanas cruzadas ----
const native: Builder = async (ctx, input, output, p) => {
  const links = new Links();
  const mount = (semis: number) => {
    links.clear();
    if (Math.abs(semis) < 0.05) return links.link(input, output);
    const ratio = Math.pow(2, semis / 12);
    const T = 0.08;
    const sr = ctx.sampleRate;
    const len = Math.round(T * sr);
    const up = ratio > 1;
    const D = Math.min(0.98, Math.abs(ratio - 1)) * T;
    const saw = ctx.createBuffer(1, len, sr);
    const win = ctx.createBuffer(1, len, sr);
    const s = saw.getChannelData(0);
    const w = win.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const x = i / len;
      s[i] = up ? 1 - x : x;
      w[i] = Math.sin(Math.PI * x) ** 2;
    }
    const t0 = ctx.currentTime + 0.05;
    for (const off of [0, T / 2]) {
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.003;
      const mod = ctx.createBufferSource();
      mod.buffer = saw;
      mod.loop = true;
      const depth = ctx.createGain();
      depth.gain.value = D;
      const env = ctx.createBufferSource();
      env.buffer = win;
      env.loop = true;
      const vca = ctx.createGain();
      vca.gain.value = 0;
      links.link(mod, depth);
      links.link(depth, delay.delayTime);
      links.link(env, vca.gain);
      links.link(input, delay);
      links.link(delay, vca);
      links.link(vca, output);
      mod.start(t0, off);
      env.start(t0, off);
      links.own(mod);
      links.own(env);
    }
  };
  let current = p.semitones;
  mount(current);
  return {
    set: (q) => { if (q.semitones !== current) mount((current = q.semitones)); },
    stop: () => links.clear(),
  };
};

// ---- 4. Robot (vocoder de canales): la portadora sale del tono destino ----
const robot: Builder = async (ctx, input, output, p) => {
  const links = new Links();
  const carrier = ctx.createOscillator();
  carrier.type = "sawtooth";
  carrier.frequency.value = p.robotHz;
  const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = nb.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = nb;
  noise.loop = true;
  const ng = ctx.createGain();
  ng.gain.value = 0.25;
  const mix = ctx.createGain();
  links.link(carrier, mix);
  links.link(noise, ng);
  links.link(ng, mix);
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) curve[i] = Math.abs(i / 511.5 - 1);
  const out = ctx.createGain();
  out.gain.value = 2.5;
  links.link(out, output);
  for (let i = 0; i < 22; i++) {
    const f = 90 * Math.pow(7000 / 90, i / 21);
    const mod = ctx.createBiquadFilter();
    mod.type = "bandpass";
    mod.frequency.value = f;
    mod.Q.value = 7;
    const rect = ctx.createWaveShaper();
    rect.curve = curve;
    const env = ctx.createBiquadFilter();
    env.type = "lowpass";
    env.frequency.value = 35;
    const eg = ctx.createGain();
    eg.gain.value = 10;
    const car = ctx.createBiquadFilter();
    car.type = "bandpass";
    car.frequency.value = f;
    car.Q.value = 7;
    const vca = ctx.createGain();
    vca.gain.value = 0;
    links.link(input, mod);
    links.link(mod, rect);
    links.link(rect, env);
    links.link(env, eg);
    links.link(mix, car);
    links.link(car, vca);
    links.link(eg, vca.gain);
    links.link(vca, out);
  }
  carrier.start();
  noise.start();
  links.own(carrier);
  links.own(noise);
  return {
    set: (q) => carrier.frequency.setTargetAtTime(q.robotHz, ctx.currentTime, 0.05),
    stop: () => links.clear(),
  };
};

const BUILDERS: Record<EngineId, Builder> = { signalsmith, tone, native, robot };

/** Arma un motor concreto. Falla si lanza un error o si no queda listo en 5 s. */
export function buildEngine(id: EngineId, ctx: AudioContext, input: AudioNode, output: AudioNode, p: VoiceParams) {
  return new Promise<Engine>((resolve, reject) => {
    let late = false;
    const timer = setTimeout(() => { late = true; reject(new Error("no respondió en 5 s")); }, TIMEOUT_MS);
    BUILDERS[id](ctx, input, output, p).then(
      (e) => {
        clearTimeout(timer);
        if (late) e.stop(); // llegó tarde: ya pasamos al siguiente motor
        else resolve(e);
      },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Prueba los motores en orden (Signalsmith → Tone → nativo → robot) y se queda con el primero que funcione.
 * Con `?voiceEngine=x` empieza por ese.
 */
export async function pickEngine(ctx: AudioContext, input: AudioNode, output: AudioNode, p: VoiceParams) {
  const forced = forcedEngine();
  const order = forced ? ENGINE_ORDER.slice(ENGINE_ORDER.indexOf(forced)) : ENGINE_ORDER;
  const failed: { id: EngineId; error: string }[] = [];
  for (const id of order) {
    try {
      const engine = await buildEngine(id, ctx, input, output, p);
      return { id, engine, failed };
    } catch (e) {
      failed.push({ id, error: e instanceof Error ? e.message : String(e) });
      console.warn(`[voz] el motor ${id} falló:`, e);
    }
  }
  throw new Error("Ningún motor de voz funcionó en este navegador");
}

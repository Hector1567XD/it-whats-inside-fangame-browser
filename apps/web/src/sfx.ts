// Efectos de sonido sintetizados con WebAudio (sin archivos). Estilo "juguete" tipo Gartic / Make it Meme.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = (() => {
  try { return localStorage.getItem("lqha:muted") === "1"; } catch { return false; }
})();

function ac() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.6;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

// Los navegadores exigen un gesto del usuario para sonar.
if (typeof window !== "undefined") {
  const unlock = () => ac();
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
}

const muteListeners = new Set<(m: boolean) => void>();
export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  try { localStorage.setItem("lqha:muted", m ? "1" : "0"); } catch {}
  if (master) master.gain.value = m ? 0 : 0.6;
  muteListeners.forEach((fn) => fn(m));
}
/** Avisa cuando cambia el 🔇 (la música de la sala lo respeta). Devuelve cómo desuscribirse. */
export function onMuteChange(fn: (m: boolean) => void) {
  muteListeners.add(fn);
  return () => { muteListeners.delete(fn); };
}

type ToneOpts = { type?: OscillatorType; vol?: number; at?: number; to?: number; attack?: number };

function tone(freq: number, dur: number, { type = "square", vol = 0.12, at = 0, to, attack = 0.005 }: ToneOpts = {}) {
  if (muted) return;
  const c = ac();
  const t = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master!);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur: number, { vol = 0.15, at = 0, from = 800, to = 3000, q = 1 } = {}) {
  if (muted) return;
  const c = ac();
  const t = c.currentTime + at;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = q;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.3);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master!);
  src.start(t);
}

const notes = (freqs: number[], step: number, o: ToneOpts & { dur?: number } = {}) =>
  freqs.forEach((f, i) => tone(f, o.dur ?? step * 1.6, { ...o, at: (o.at ?? 0) + i * step }));

export const sfx = {
  click: () => tone(880, 0.05, { vol: 0.06 }),
  pop: () => tone(420, 0.1, { type: "sine", to: 900, vol: 0.18 }),
  send: () => tone(600, 0.08, { type: "triangle", to: 1400, vol: 0.14 }),
  join: () => notes([523, 784], 0.08, { type: "triangle", vol: 0.14 }),
  boing: () => tone(180, 0.35, { type: "sine", to: 620, vol: 0.2 }),
  vote: () => notes([660, 990], 0.06, { type: "square", vol: 0.07 }),
  error: () => tone(150, 0.3, { type: "sawtooth", to: 90, vol: 0.1 }),
  tick: () => tone(1200, 0.04, { type: "square", vol: 0.05 }),
  tickHot: () => { tone(1500, 0.06, { type: "square", vol: 0.09 }); tone(750, 0.06, { type: "square", vol: 0.05 }); },
  whoosh: () => noise(0.45, { from: 400, to: 5000, vol: 0.2 }),
  slam: () => { tone(90, 0.3, { type: "sine", to: 40, vol: 0.35 }); noise(0.15, { from: 2000, to: 300, vol: 0.2 }); },
  day: () => {
    sfx.whoosh();
    notes([523, 659, 784, 1047], 0.09, { type: "square", vol: 0.08, at: 0.25 });
    notes([262, 330, 392, 523], 0.09, { type: "triangle", vol: 0.1, at: 0.25 });
  },
  night: () => {
    sfx.whoosh();
    notes([659, 523, 440, 330], 0.14, { type: "sine", vol: 0.14, at: 0.2, dur: 0.5 });
    tone(110, 1.2, { type: "triangle", vol: 0.12, at: 0.2 });
  },
  swap: () => {
    // warble caótico + whoosh largo
    for (let i = 0; i < 16; i++) tone(300 + Math.random() * 900, 0.09, { type: "square", vol: 0.05, at: i * 0.12 });
    noise(2, { from: 200, to: 6000, vol: 0.12, q: 3 });
  },
  land: () => { sfx.slam(); notes([392, 523, 659, 784, 1047], 0.07, { type: "triangle", vol: 0.12, at: 0.05 }); },
  guess: () => { sfx.whoosh(); notes([392, 466, 392, 587], 0.16, { type: "triangle", vol: 0.12, at: 0.2 }); },
  drumroll: (dur = 1.2) => { for (let t = 0; t < dur; t += 0.05) noise(0.06, { at: t, from: 1500, to: 1200, vol: 0.05 + (t / dur) * 0.1, q: 0.7 }); },
  reveal: () => { tone(1320, 0.5, { type: "sine", vol: 0.2 }); tone(1980, 0.4, { type: "sine", vol: 0.1, at: 0.02 }); },
  fail: () => notes([400, 300], 0.15, { type: "sawtooth", vol: 0.06 }),
  // 📲 Timbre de teléfono (440 + 480 Hz, dos toques), fuerte para que se note la llamada.
  ring: () => {
    for (const at of [0, 0.5]) {
      tone(440, 0.4, { type: "sine", vol: 0.35, at, attack: 0.02 });
      tone(480, 0.4, { type: "sine", vol: 0.35, at, attack: 0.02 });
    }
  },
  win: () => {
    notes([523, 659, 784], 0.1, { type: "square", vol: 0.08 });
    notes([1047, 1047, 1319, 1568], 0.12, { type: "square", vol: 0.08, at: 0.35 });
    notes([262, 392, 523], 0.2, { type: "triangle", vol: 0.12, at: 0.35 });
  },
};

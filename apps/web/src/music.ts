// 🎵 Música de la sala de espera: tres loops tranquilos sintetizados con WebAudio (sin archivos), bajitos para
// no tapar la voz. El host elige cuál suena (o ninguna); cada quien la apaga con el 🔇 de arriba.
import { isMuted, onMuteChange } from "./sfx";

type Note = { f: number; at: number; dur: number; vol: number; type: OscillatorType };
type Song = { label: string; icon: string; bpm: number; steps: number; lowpass: number; notes: (step: number, bar: number) => Note[] };

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
// Acordes en MIDI (raíz, tercera, quinta, séptima)
const CHORDS_LOFI = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 65]]; // Am7 Fmaj7 Cmaj7 G7
const CHORDS_BOX = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]]; // C Am F G
const CHORDS_PAD = [[50, 57, 62, 65], [48, 55, 60, 64], [46, 53, 58, 62], [48, 55, 60, 67]]; // Dm C Bb C

export const SONGS: Song[] = [
  {
    label: "Lo-fi", icon: "☕", bpm: 76, steps: 8, lowpass: 1800,
    notes: (step, bar) => {
      const ch = CHORDS_LOFI[bar % 4];
      const out: Note[] = [];
      if (step === 0) ch.forEach((m, i) => out.push({ f: hz(m), at: i * 0.02, dur: 3, vol: 0.05, type: "triangle" }));
      if (step === 0 || step === 5) out.push({ f: hz(ch[0] - 12), at: 0, dur: 0.9, vol: 0.09, type: "sine" });
      if (step === 3 || step === 6) out.push({ f: hz(ch[(step + bar) % ch.length] + 12), at: 0, dur: 0.5, vol: 0.025, type: "sine" });
      return out;
    },
  },
  {
    label: "Cajita de música", icon: "🎁", bpm: 92, steps: 8, lowpass: 4200,
    notes: (step, bar) => {
      const ch = CHORDS_BOX[bar % 4];
      const arp = [0, 1, 2, 1, 2, 1, 0, 1];
      const out: Note[] = [{ f: hz(ch[arp[step]] + 12), at: 0, dur: 0.7, vol: 0.035, type: "sine" }];
      if (step === 0) out.push({ f: hz(ch[0] - 12), at: 0, dur: 1.6, vol: 0.05, type: "triangle" });
      return out;
    },
  },
  {
    label: "Ambiente", icon: "🌊", bpm: 50, steps: 4, lowpass: 1100,
    notes: (step, bar) => {
      if (step !== 0) return [];
      return CHORDS_PAD[bar % 4].map((m, i) => ({ f: hz(m), at: i * 0.15, dur: 5.2, vol: 0.035, type: "sawtooth" as const }));
    },
  },
];

class Player {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private lp: BiquadFilterNode | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private song = 0; // 1..3 (0 = nada)
  private next = 0; // tiempo del próximo paso
  private step = 0;
  private bar = 0;

  constructor() {
    onMuteChange(() => this.applyVolume());
    // Si el contexto quedó suspendido (sin gesto del usuario), cualquier toque lo arranca.
    const wake = () => { if (this.ctx?.state === "suspended") void this.ctx.resume(); };
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
  }

  play(song: number) {
    if (song === this.song) return;
    this.stop();
    this.song = song;
    if (!SONGS[song - 1]) return;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.out = this.ctx.createGain();
      this.lp = this.ctx.createBiquadFilter();
      this.lp.type = "lowpass";
      this.out.connect(this.lp).connect(this.ctx.destination);
    }
    void this.ctx.resume().catch(() => {});
    this.lp!.frequency.value = SONGS[song - 1].lowpass;
    this.applyVolume(true);
    this.next = this.ctx.currentTime + 0.1;
    this.step = 0;
    this.bar = 0;
    this.timer = setInterval(() => this.schedule(), 100);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.song = 0;
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
  }

  private applyVolume(fadeIn = false) {
    if (!this.out || !this.ctx) return;
    const target = isMuted() || !this.song ? 0 : 1;
    this.out.gain.cancelScheduledValues(this.ctx.currentTime);
    if (fadeIn) this.out.gain.setValueAtTime(0, this.ctx.currentTime);
    this.out.gain.setTargetAtTime(target, this.ctx.currentTime, fadeIn ? 0.8 : 0.15);
  }

  /** Programa los pasos que caen en los próximos 0,4 s (así un tab en segundo plano no la corta). */
  private schedule() {
    const song = SONGS[this.song - 1];
    if (!song || !this.ctx || !this.out) return;
    const stepDur = 60 / song.bpm / 2;
    while (this.next < this.ctx.currentTime + 0.4) {
      for (const n of song.notes(this.step, this.bar)) this.note(n, this.next);
      this.next += stepDur;
      if (++this.step >= song.steps) { this.step = 0; this.bar++; }
    }
  }

  private note(n: Note, t0: number) {
    const ctx = this.ctx!;
    const t = t0 + n.at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = n.type;
    o.frequency.value = n.f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(n.vol, t + Math.min(0.4, n.dur * 0.15));
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    o.connect(g).connect(this.out!);
    o.start(t);
    o.stop(t + n.dur + 0.05);
  }
}

let player: Player | null = null;
/** Pone la canción `song` (1–3) o apaga la música (0). */
export function setMusic(song: number) {
  if (!player) {
    if (!song) return;
    player = new Player();
  }
  player.play(song);
}

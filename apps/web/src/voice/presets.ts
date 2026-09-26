import type { VoiceKind } from "../net";

export type VoiceType = Exclude<VoiceKind, "" | "listen">;
export type VoiceParams = {
  semitones: number; // tono (todos los motores menos el robot)
  formant: number; // formantes en semitonos (solo Signalsmith)
  tilt: number; // timbre en dB: − grave, + brillante
  robotHz: number; // portadora del vocoder
  f0: number; // tono base del jugador (Signalsmith lo usa para compensar formantes)
};

export const DEFAULT_F0 = 150;

export const VOICE_TYPES: Record<VoiceType, { icon: string; label: string; desc: string }> = {
  fem: { icon: "♀", label: "Femenina", desc: "Aguda y brillante" },
  masc: { icon: "♂", label: "Masculina", desc: "Grave y oscura" },
  neutral: { icon: "⚪", label: "Neutra", desc: "Ni muy aguda ni muy grave" },
};
export const isVoiceType = (v: string): v is VoiceType => v in VOICE_TYPES;

// Ajustable de oído. Cada variante mueve un poco el tono destino, los formantes y el timbre,
// así dos personas con el mismo tipo no suenan iguales.
const TABLE: Record<VoiceType, { hz: number[]; formant: number; tilt: number; robot: number }> = {
  masc: { hz: [115, 100, 132, 108, 124], formant: -2, tilt: -3, robot: 100 },
  fem: { hz: [215, 195, 238, 205, 228], formant: 2.5, tilt: 3, robot: 200 },
  neutral: { hz: [160, 145, 176, 152, 168], formant: 0, tilt: 0, robot: 150 },
};
const FORMANT_OFF = [0, -0.5, 0.5, -1, 1];
const TILT_OFF = [0, 1, -1, 0.5, -0.5];

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function paramsFor(voice: VoiceType, variant: number, f0 = DEFAULT_F0): VoiceParams {
  const t = TABLE[voice];
  const i = variant % t.hz.length;
  // A partir de la 6.ª persona con el mismo tipo se repite la tabla un 4 % más aguda por vuelta.
  const lap = Math.floor(variant / t.hz.length);
  const target = t.hz[i] * (1 + 0.04 * lap);
  const base = f0 > 0 ? f0 : DEFAULT_F0;
  return {
    semitones: clamp(Math.round(2 * 12 * Math.log2(target / base)) / 2, -12, 12),
    formant: t.formant + FORMANT_OFF[i],
    tilt: t.tilt + TILT_OFF[i],
    robotHz: Math.round(t.robot * (target / t.hz[0])),
    f0: base,
  };
}

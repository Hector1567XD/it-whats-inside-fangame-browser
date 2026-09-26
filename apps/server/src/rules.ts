// Reglas puras del juego (sin estado de sala): modos, mínimos, ciclos automáticos, puntos y resolución de votos.
import type { Mode } from "./GameState.js";

export const MODES: Record<Mode, { min: number; env: string }> = {
  classic: { min: 5, env: "MIN_PLAYERS_CLASSIC" },
  all: { min: 4, env: "MIN_PLAYERS_ALL" },
  immutable: { min: 5, env: "MIN_PLAYERS_IMMUTABLE" },
  still: { min: 4, env: "MIN_PLAYERS_STILL" },
};

if (process.env.MIN_PLAYERS) {
  console.warn(
    `⚠️  MIN_PLAYERS=${process.env.MIN_PLAYERS} se ignora: ahora cada modo tiene su mínimo. ` +
      `Para pruebas usa ${Object.values(MODES).map((m) => m.env).join(", ")}.`,
  );
}

/** Mínimo de jugadores del modo; se puede pisar con MIN_PLAYERS_<MODO> (útil para probar con poca gente). */
export function minPlayersFor(mode: Mode) {
  const raw = process.env[MODES[mode].env];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : MODES[mode].min;
}

export const isImmutableMode = (m: Mode) => m === "immutable" || m === "still";

/** Chats que cada jugador puede iniciar por noche en modo automático. */
export const autoChats = (players: number) => Math.min(5, Math.max(2, Math.floor(players / 2)));

/** Mayoría simple de los conectados (para el botón de saltar). */
export const skipNeeded = (connected: number) => Math.floor(connected / 2) + 1;

/**
 * Ciclos en Auto.
 * El Inmutable: con s cambios un cambiante descarta 1 + s cuerpos; para llegar al final con ≥3 candidatos, s ≤ N − 4.
 */
export function autoCycles(mode: Mode, n: number, earlyVote: boolean) {
  if (mode === "immutable") return Math.max(1, Math.min(3, n - 4));
  if (mode === "still") return n >= 6 ? 3 : 2;
  return earlyVote ? (n >= 9 ? 3 : 2) : 1;
}

/** Cuántos cambian de cuerpo al empezar (modos de adivinanza). Clásico: 2..N-2 al azar; Todos: todos. */
export function swapCount(mode: Mode, n: number) {
  if (n < 2) return 0;
  if (mode === "classic") return 2 + Math.floor(Math.random() * (Math.max(2, n - 2) - 1));
  return n;
}

export const POINTS = {
  // ¿Quién es quién?
  guessSwap: 200,
  guessSame: 50,
  bonus: 150, // 🥷 Sigilo / 🎭 Despiste
  // 🎭 El Desenmascare
  unmask: 200, // cada acusador correcto (cuerpo cambiado)
  unmasked: -200, // la mente expuesta
  unmaskSame: 100, // acusador correcto de alguien que no cambió
  unmaskedSame: -150,
  // Inmutables
  changersWin: 150, // cada cambiante, también los expulsados
  votedImmutable: 200, // extra a quien votó por el Inmutable cuando salió
  votedChanger: -50, // votaste por un cambiante y lo expulsaron
  immutableEjects: 100, // el Inmutable, por cada cambiante expulsado
  immutableSurvives: 100, // el Inmutable, por cada votación entre ciclos que sobrevive
  immutableWins: 500,
};

export type Verdict = {
  kind: "UNMASK" | "VOTE" | "FINAL_VOTE";
  outcome: "none" | "ejected";
  reason?: "tie" | "skip" | "noVotes";
  bodyId?: string;
  mindId?: string;
  wasSame?: boolean; // desenmascarado sin haber cambiado
  wasImmutable?: boolean;
  tally?: Record<string, number>; // cuerpo -> votos, "skip" -> omitir (solo Votación / Juicio Final)
  winner?: "changers" | "immutable";
};

/**
 * 🎭 El Desenmascare. Sale el cuerpo con más acusaciones CORRECTAS si llega al 60% de los activos
 * (sin contar a la mente acusada). Empate arriba = nadie. Máximo uno.
 */
export function resolveUnmask({ accusations, truth, activeCount, allowSame }: {
  accusations: Map<string, { body: string; mind: string } | null>;
  truth: Record<string, string>; // cuerpo activo -> mente adentro
  activeCount: number;
  allowSame: boolean;
}): { bodyId: string; mindId: string; correct: string[] } | null {
  const byBody = new Map<string, string[]>();
  for (const [voter, acc] of accusations) {
    if (!acc || truth[acc.body] !== acc.mind) continue;
    if (acc.body === acc.mind && !allowSame) continue;
    byBody.set(acc.body, [...(byBody.get(acc.body) ?? []), voter]);
  }
  let best: [string, string[]] | null = null;
  let tie = false;
  for (const entry of byBody) {
    if (!best || entry[1].length > best[1].length) {
      best = entry;
      tie = false;
    } else if (entry[1].length === best[1].length) tie = true;
  }
  const need = Math.ceil(0.6 * Math.max(1, activeCount - 1));
  if (!best || tie || best[1].length < need) return null;
  return { bodyId: best[0], mindId: truth[best[0]], correct: best[1] };
}

/**
 * 🗳️ La Votación / ⚖️ Juicio Final (estilo Among Us): gana el cuerpo con más votos aunque sea 1.
 * Empate, u Omitir igual o mayor que el máximo = nadie. No votar no cuenta.
 */
export function resolvePlurality(votes: Map<string, string | null>) {
  const tally: Record<string, number> = {};
  let skip = 0;
  for (const b of votes.values()) {
    if (b === null) skip++;
    else tally[b] = (tally[b] ?? 0) + 1;
  }
  const withSkip = skip > 0 ? { ...tally, skip } : tally;
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return { top: null, reason: skip > 0 ? ("skip" as const) : ("noVotes" as const), tally: withSkip };
  const [first, second] = entries;
  if (skip >= first[1]) return { top: null, reason: "skip" as const, tally: withSkip };
  if (second && second[1] === first[1]) return { top: null, reason: "tie" as const, tally: withSkip };
  return { top: first[0], reason: undefined, tally: withSkip };
}

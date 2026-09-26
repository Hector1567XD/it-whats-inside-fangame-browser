import { Client, Room } from "colyseus.js";

const env = import.meta.env;
const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
// En dev con HTTPS=1 (probar el micrófono en el celular) Vite hace de proxy: mismo origen.
export const SERVER_WS: string =
  env.VITE_SERVER_URL ?? (env.DEV && location.protocol !== "https:" ? `${wsProto}//${location.hostname}:2567` : `${wsProto}//${location.host}`);
export const SERVER_HTTP = SERVER_WS.replace(/^ws/, "http");

export const client = new Client(SERVER_WS);

const KEY = "lqha:reconnect";
export function saveReconnect(room: Room) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ roomId: room.roomId, token: room.reconnectionToken }));
  } catch {}
}
export function loadReconnect(): { roomId: string; token: string } | null {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
}
export function clearReconnect() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
}

export async function roomInfo(code: string) {
  const r = await fetch(`${SERVER_HTTP}/api/rooms/${encodeURIComponent(code)}`);
  return (await r.json()) as { exists: boolean; phase?: Phase; names?: string[] };
}

// ---- tipos que espejan el server ----
export type Phase =
  | "LOBBY" | "SWAP" | "QUESTION" | "THREAD" | "DAY" | "NIGHT"
  | "UNMASK" | "VOTE" | "VERDICT" | "GUESS" | "FINAL_VOTE" | "RESULTS";
export type Mode = "classic" | "all" | "immutable" | "still";
export type Role = "immutable" | "changer" | null;
export type PlayerView = {
  id: string; name: string; color: string; avatar: string; score: number; lastPoints: number;
  connected: boolean; submitted: boolean; skipVote: boolean; out: boolean; bodyOut: boolean;
  voice: VoiceKind; voiceVariant: number; micOn: boolean; // voz del lobby
};
/** "" = sin voz, "listen" = solo escucha. */
export type VoiceKind = "" | "listen" | "fem" | "masc" | "neutral";
export type Settings = {
  mode: Mode; cycles: number;
  questionSeconds: number; threadSeconds: number; daySeconds: number; nightSeconds: number; guessSeconds: number;
  chatsPerNight: number; // 0 = auto
  earlyVote: boolean; voteSeconds: number; maxEjections: number; unmaskSame: boolean;
  voiceWalkie: number; // 📻 0 off · 1 poquito · 2 bastante
  voicePhases: boolean; // ☀️ Chat global y 🌙 privado por voz en vez de texto
};
/** 🌙 Llamadas por voz (por cuerpo): a quién llamo, quién me llama y con quién ya hablé esta noche. */
export type CallState = { target: string; incoming: string[]; pairs: string[] };
export type ReplyView = { id: string; body: string; text: string; likes: number; sus: number };
export type PostView = ReplyView & { replies: ReplyView[] };
export type StateView = {
  phase: Phase;
  cycle: number;
  totalCycles: number;
  round: number;
  timer: number;
  hostId: string;
  minPlayers: number;
  maxPlayers: number;
  sfu: boolean; // el server tiene el SFU de Cloudflare (necesario para la voz en partida)
  chatLimit: number;
  question: string;
  posts: PostView[];
  thread: number;
  settings: Settings;
  players: Record<string, PlayerView>;
};
export type Quote = { id: string; body: string; text: string };
export type ChatMsg = { fromBody: string; real: boolean; tag: string; text: string; ts: number; quote?: Quote };
export type DmMsg = { fromBody: string; text: string; ts: number; withBody: string };
export type RoundResult = {
  mindId: string;
  bodyId: string;
  swapped: boolean;
  out: boolean;
  hits: number;
  sameHits: number;
  guessedBy: number;
  fooled: number;
  bonus: "stealth" | "decoy" | null;
  early: number;
  points: number;
};
export type Ejection = { cycle: number; kind: "UNMASK" | "VOTE" | "FINAL_VOTE"; bodyId: string; mindId: string; wasImmutable: boolean };
export type GuessResults = { family: "guess"; mode: Mode; results: RoundResult[]; guesses: Record<string, Record<string, string>>; ejections: Ejection[] };
export type ImmutableResults = {
  family: "immutable"; mode: Mode; immutableId: string; winner: "changers" | "immutable";
  bodies: Record<string, string>; history: Record<string, string[]>; ejections: Ejection[]; points: Record<string, number>;
};
export type ResultsPayload = GuessResults | ImmutableResults;
export type Verdict = {
  kind: "UNMASK" | "VOTE" | "FINAL_VOTE";
  outcome: "none" | "ejected";
  reason?: "tie" | "skip" | "noVotes";
  bodyId?: string;
  mindId?: string;
  wasSame?: boolean;
  wasImmutable?: boolean;
  ghost?: boolean; // Inmutables, votación intermedia: salió un cambiante y no se revela qué alma tenía
  tally?: Record<string, number>;
  winner?: "changers" | "immutable";
};

/** Espectadores: quién chatea con quién esta noche (por cuerpo), sin el contenido. */
export type ChatEdge = { a: string; b: string; count: number; last: number };

/**
 * Mentes que siguen en juego. Se cuenta por cuerpos: un cuerpo expulsado como fantasma no marca
 * públicamente a su mente como `out`, pero siempre hay tantas mentes activas como cuerpos en juego.
 */
export const activeCount = (players: PlayerView[]) => players.filter((p) => !p.bodyOut).length;
/** Fantasmas: mentes expulsadas que todavía no se revelaron. */
export const ghostCount = (players: PlayerView[]) =>
  players.filter((p) => p.bodyOut).length - players.filter((p) => p.out).length;

export const MODES: Record<Mode, { icon: string; label: string; desc: string; family: "guess" | "immutable" }> = {
  classic: { icon: "🎲", label: "Clásico", desc: "Cambian algunos (siempre quedan 2 en su cuerpo). Nadie sabe cuántos.", family: "guess" },
  all: { icon: "🔀", label: "Todos cambian", desc: "Todas las mentes cambian de cuerpo.", family: "guess" },
  immutable: { icon: "🗿", label: "El Inmutable", desc: "Uno nunca cambia; los demás cambian cada ciclo. ¡Expúlsalo!", family: "immutable" },
  still: { icon: "🪨", label: "El No Cambiante", desc: "Uno nunca cambia; los demás cambian una sola vez. ¡Expúlsalo!", family: "immutable" },
};
export const isImmutableMode = (m: Mode) => MODES[m].family === "immutable";
export const REACTIONS = ["😂", "😭", "😊", "❤️", "😡", "👏", "🤔", "👀", "🤡"];

// Mismas fórmulas que el server (rules.ts)
export const autoChats = (players: number) => Math.min(5, Math.max(2, Math.floor(players / 2)));
export const skipNeeded = (connected: number) => Math.floor(connected / 2) + 1;
export function autoCycles(mode: Mode, n: number, earlyVote: boolean) {
  if (mode === "immutable") return Math.max(1, Math.min(3, n - 4));
  if (mode === "still") return n >= 6 ? 3 : 2;
  return earlyVote ? (n >= 9 ? 3 : 2) : 1;
}

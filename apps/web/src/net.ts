import { Client, Room } from "colyseus.js";

const env = import.meta.env;
const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
export const SERVER_WS: string =
  env.VITE_SERVER_URL ?? (env.DEV ? `${wsProto}//${location.hostname}:2567` : `${wsProto}//${location.host}`);
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
export type Phase = "LOBBY" | "SWAP" | "QUESTION" | "THREAD" | "DAY" | "NIGHT" | "GUESS" | "RESULTS";
export type Mode = "classic" | "all";
export type PlayerView = {
  id: string; name: string; color: string; avatar: string; score: number; lastPoints: number;
  connected: boolean; submitted: boolean; skipVote: boolean;
};
export type Settings = {
  mode: Mode; cycles: number;
  questionSeconds: number; threadSeconds: number; daySeconds: number; nightSeconds: number; guessSeconds: number;
  chatsPerNight: number; // 0 = auto
};
export type ReplyView = { id: string; body: string; text: string; likes: number };
export type PostView = ReplyView & { replies: ReplyView[] };
export type StateView = {
  phase: Phase;
  cycle: number;
  round: number;
  timer: number;
  hostId: string;
  minPlayers: number;
  maxPlayers: number;
  chatLimit: number;
  question: string;
  posts: PostView[];
  thread: number;
  settings: Settings;
  players: Record<string, PlayerView>;
};
export type ChatMsg = { fromBody: string; real: boolean; tag: string; text: string; ts: number };
export type DmMsg = { fromBody: string; text: string; ts: number; withBody: string };
export type RoundResult = {
  mindId: string;
  bodyId: string;
  swapped: boolean;
  hits: number;
  sameHits: number;
  guessedBy: number;
  fooled: number;
  bonus: "stealth" | "decoy" | null;
  points: number;
};
export type ResultsPayload = { mode: Mode; results: RoundResult[]; guesses: Record<string, Record<string, string>> };

export const MODES: Record<Mode, { icon: string; label: string; desc: string }> = {
  classic: { icon: "🎲", label: "Clásico", desc: "Cambian algunos (mín. 2, siempre quedan 2 en su cuerpo). Nadie sabe cuántos." },
  all: { icon: "🔀", label: "Todos cambian", desc: "Todas las mentes cambian de cuerpo." },
};

// Mismas fórmulas que el server (GameRoom.ts)
export const autoChats = (players: number) => Math.min(5, Math.max(2, Math.floor(players / 2)));
export const skipNeeded = (connected: number) => Math.floor(connected / 2) + 1;

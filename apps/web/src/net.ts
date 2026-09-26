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
  return (await r.json()) as { exists: boolean; locked?: boolean; clients?: number; maxClients?: number };
}

// ---- tipos que espejan el server ----
export type Phase = "LOBBY" | "SWAP" | "DAY" | "NIGHT" | "GUESS" | "RESULTS";
export type PlayerView = {
  id: string; name: string; color: string; avatar: string; score: number;
  connected: boolean; submitted: boolean; skipVote: boolean;
};
export type Settings = {
  days: number; nights: number; daySeconds: number; nightSeconds: number; guessSeconds: number;
  chatsPerNight: number; // 0 = auto
};
export type StateView = {
  phase: Phase;
  dayCount: number;
  round: number;
  timer: number;
  hostId: string;
  minPlayers: number;
  chatLimit: number;
  settings: Settings;
  players: Record<string, PlayerView>;
};
export type ChatMsg = { fromBody: string; real: boolean; tag: string; text: string; ts: number };
export type DmMsg = { fromBody: string; text: string; ts: number; withBody: string };
export type RoundResult = {
  mindId: string;
  bodyId: string;
  correct: number;
  guessedBy: number;
  stealth: boolean;
  points: number;
};

// Mismas fórmulas que el server (GameRoom.ts)
export const autoChats = (players: number) => (players <= 5 ? 2 : players <= 7 ? 3 : 4);
export const skipNeeded = (connected: number) => Math.floor(connected / 2) + 1;

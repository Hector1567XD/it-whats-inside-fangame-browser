import type { Room } from "colyseus.js";

let seq = 0;

/** Petición al server por el WS ("sfu"), que contesta con el mismo `rid`. */
export function sfuRequest<T = Record<string, any>>(room: Room, op: string, data: object = {}, timeoutMs = 15000) {
  const rid = ++seq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`el server no respondió (${op})`)); }, timeoutMs);
    const off = room.onMessage("sfu", (m: { rid?: number; error?: string }) => {
      if (m?.rid !== rid) return;
      clearTimeout(timer);
      off();
      if (m.error) reject(new Error(m.error));
      else resolve(m as T);
    });
    room.send("sfu", { rid, op, ...data });
  });
}

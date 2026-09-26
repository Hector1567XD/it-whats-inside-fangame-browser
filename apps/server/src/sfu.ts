/**
 * Cliente mínimo de la API de Cloudflare Realtime SFU. El secreto vive solo aquí (server), nunca en el navegador.
 * Docs: https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/
 *
 * Variables: CF_SFU_APP_ID + CF_SFU_APP_TOKEN (sin ellas la voz usa la malla P2P).
 * Opcional: CF_TURN_KEY_ID + CF_TURN_KEY_TOKEN para dar credenciales TURN (respaldo en redes que bloquean UDP).
 * Se leen al usarse (no al importar) para que el .env cargado en index.ts ya esté aplicado.
 */
const BASE = "https://rtc.live.cloudflare.com/v1";
const TIMEOUT_MS = 10_000;

export type SessionDescription = { type: "offer" | "answer"; sdp: string };
export type TrackResult = {
  location?: "local" | "remote"; mid?: string; sessionId?: string; trackName?: string;
  errorCode?: string; errorDescription?: string;
};
type TracksResponse = {
  errorCode?: string; errorDescription?: string;
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: SessionDescription;
  tracks?: TrackResult[];
};

const env = () => ({ appId: process.env.CF_SFU_APP_ID ?? "", token: process.env.CF_SFU_APP_TOKEN ?? "" });
export const sfuEnabled = () => !!(env().appId && env().token);

async function call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const { appId, token } = env();
  const res = await fetch(`${BASE}/apps/${appId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as T & { errorCode?: string; errorDescription?: string };
  if (!res.ok || json.errorCode) {
    throw new Error(`Cloudflare SFU ${method} ${path.replace(/[0-9a-f]{20,}/g, "…")} → ${res.status} ${json.errorCode ?? ""} ${json.errorDescription ?? ""}`.trim());
  }
  return json;
}

export const sfu = {
  async newSession() {
    return (await call<{ sessionId: string }>("POST", "/sessions/new")).sessionId;
  },
  /** Publicar: la oferta del navegador + su mid. Devuelve la respuesta (answer) del SFU. */
  push(session: string, offer: SessionDescription, mid: string, trackName: string) {
    return call<TracksResponse>("POST", `/sessions/${session}/tracks/new`, {
      sessionDescription: offer,
      tracks: [{ location: "local", mid, trackName }],
    });
  },
  /** Suscribirse a publicaciones de otros. El SFU devuelve una oferta que el navegador tiene que contestar. */
  pull(session: string, tracks: { sessionId: string; trackName: string }[]) {
    return call<TracksResponse>("POST", `/sessions/${session}/tracks/new`, {
      tracks: tracks.map((t) => ({ location: "remote", ...t })),
    });
  },
  renegotiate(session: string, answer: SessionDescription) {
    return call<TracksResponse>("PUT", `/sessions/${session}/renegotiate`, { sessionDescription: answer });
  },
  /** Cierre sin renegociar (force): el SFU deja de reenviar esos mids. */
  close(session: string, mids: string[]) {
    return call<TracksResponse>("PUT", `/sessions/${session}/tracks/close`, { tracks: mids.map((mid) => ({ mid })), force: true });
  },
};

/** ICE para el navegador: STUN de Cloudflare y, si hay TURN configurado, credenciales temporales. */
export async function iceServers(): Promise<unknown[]> {
  const stun = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
  const id = process.env.CF_TURN_KEY_ID;
  const token = process.env.CF_TURN_KEY_TOKEN;
  if (!id || !token) return stun;
  try {
    const res = await fetch(`${BASE}/turn/keys/${id}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 6 * 3600 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { iceServers } = (await res.json()) as { iceServers: { urls: string[] | string }[] };
    // El puerto 53 lo bloquean los navegadores: solo haría esperar un timeout.
    return iceServers.map((s) => ({ ...s, urls: [s.urls].flat().filter((u) => !/:53\b/.test(u)) }));
  } catch (e) {
    console.warn("[voz] no se pudieron generar credenciales TURN:", e);
    return stun;
  }
}

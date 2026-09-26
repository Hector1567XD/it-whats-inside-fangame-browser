/** Lo que el hook necesita de un transporte de voz: la malla P2P (mesh.ts) o el SFU de Cloudflare (sfu.ts). */
export interface VoiceTransport {
  /** Estado de la conexión con cada jugador. */
  state: Record<string, RTCPeerConnectionState>;
  /** Algún <audio> no pudo arrancar sin un toque (Safari/iOS). */
  blocked: boolean;
  /** Un problema general (p. ej. no conecta con el servidor de voz); vacío si todo va bien. */
  problem: string;
  onChange: () => void;
  /** A quiénes hay que oír. */
  sync(ids: string[]): void;
  deafen(on: boolean): void;
  unblock(): void;
  /** Nivel (0–1) que llega de cada jugador. */
  levels(): Record<string, number>;
  destroy(): void;
}

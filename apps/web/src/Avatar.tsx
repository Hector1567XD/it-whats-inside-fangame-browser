import { createAvatar } from "@dicebear/core";
import * as bigSmile from "@dicebear/big-smile";
import * as adventurer from "@dicebear/adventurer";
import * as croodles from "@dicebear/croodles";
import type { CSSProperties } from "react";

// Mismos ids que AVATAR_STYLES en el server.
export const STYLES = {
  "big-smile": { label: "Sonrisa", style: bigSmile },
  adventurer: { label: "Aventura", style: adventurer },
  croodles: { label: "Garabato", style: croodles },
} as const;
export type StyleId = keyof typeof STYLES;
export const STYLE_IDS = Object.keys(STYLES) as StyleId[];

export const randomSeed = () => Math.random().toString(36).slice(2, 10);
/** Avatar guardado de una versión anterior con un estilo que ya no existe -> uno nuevo. */
export const validAvatar = (a: string | null) => (a && a.split(":")[0] in STYLES ? a : randomAvatar());
export const randomAvatar = (style?: StyleId) =>
  `${style ?? STYLE_IDS[Math.floor(Math.random() * STYLE_IDS.length)]}:${randomSeed()}`;

const cache = new Map<string, string>();
export function avatarUri(avatar: string) {
  let uri = cache.get(avatar);
  if (!uri) {
    const [id, seed] = avatar.split(":");
    const s = STYLES[id as StyleId] ?? STYLES["big-smile"];
    uri = createAvatar(s.style as any, { seed: seed || id }).toDataUri();
    cache.set(avatar, uri);
  }
  return uri;
}

export function Avatar({ avatar, color, size, className = "", style }: {
  avatar?: string; color: string; size: number; className?: string; style?: CSSProperties;
}) {
  return (
    <span className={"avatar " + className} style={{ background: color, width: size, height: size, ...style }}>
      <img src={avatarUri(avatar || "big-smile:x")} alt="" draggable={false} />
    </span>
  );
}

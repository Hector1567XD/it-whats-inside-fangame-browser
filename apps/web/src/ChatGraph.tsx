import { useEffect, useRef, useState } from "react";
import { avatarUri } from "./Avatar";
import { sfx } from "./sfx";
import type { ChatEdge, PlayerView } from "./net";

/**
 * Noche para espectadores: los cuerpos en círculo y una línea entre cada par que se está escribiendo.
 * Nunca se ve el contenido, solo quién habla con quién (y cuánto).
 */
export function ChatGraph({ players, edges }: { players: PlayerView[]; edges: ChatEdge[] }) {
  const bodies = players.filter((p) => !p.bodyOut);
  const size = 440;
  const c = size / 2;
  const r = size / 2 - 64;
  const pos = new Map(
    bodies.map((p, i) => {
      const a = (i / bodies.length) * Math.PI * 2 - Math.PI / 2;
      return [p.id, { x: c + r * Math.cos(a), y: c + r * Math.sin(a) }];
    }),
  );

  // Destello en la línea que acaba de recibir un mensaje
  const prev = useRef<Record<string, number>>({});
  const [hot, setHot] = useState<Record<string, number>>({});
  useEffect(() => {
    const now: Record<string, number> = {};
    let fresh = false;
    for (const e of edges) {
      const k = e.a + "|" + e.b;
      if ((prev.current[k] ?? 0) < e.count) { now[k] = Date.now(); fresh = true; }
      prev.current[k] = e.count;
    }
    if (fresh) {
      sfx.pop();
      setHot((h) => ({ ...h, ...now }));
    }
  }, [edges]);

  const name = (id: string) => players.find((p) => p.id === id)?.name ?? "?";
  const sorted = [...edges].sort((x, y) => y.last - x.last);

  return (
    <div className="card cgraph">
      <h3>🕸️ Quién chatea con quién</h3>
      <p className="muted small">👻 Eres espectador: ves las conversaciones de esta noche, pero no lo que dicen.</p>
      <div className="cgraph-wrap">
        <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Grafo de chats privados">
          {edges.map((e) => {
            const a = pos.get(e.a);
            const b = pos.get(e.b);
            if (!a || !b) return null;
            const k = e.a + "|" + e.b;
            return (
              <line key={k + (hot[k] ?? 0)} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                className={"cg-edge" + (hot[k] ? " hot" : "")} strokeWidth={2 + Math.min(10, e.count)} />
            );
          })}
          {bodies.map((p) => {
            const at = pos.get(p.id)!;
            const talking = edges.some((e) => e.a === p.id || e.b === p.id);
            return (
              <g key={p.id} className={"cg-node" + (talking ? " talking" : "")} transform={`translate(${at.x} ${at.y})`}>
                <circle r={30} fill={p.color} className="cg-ring" />
                <image href={avatarUri(p.avatar)} x={-25} y={-25} width={50} height={50} />
                <text y={48} textAnchor="middle" className="cg-name">{p.name}</text>
              </g>
            );
          })}
        </svg>
      </div>
      {sorted.length === 0 ? (
        <p className="muted center-text">🤫 Nadie ha escrito todavía…</p>
      ) : (
        <ul className="cg-list">
          {sorted.map((e) => (
            <li key={e.a + e.b}>
              <b>{name(e.a)}</b> ↔ <b>{name(e.b)}</b>
              <span className="muted"> · {e.count} mensaje{e.count === 1 ? "" : "s"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

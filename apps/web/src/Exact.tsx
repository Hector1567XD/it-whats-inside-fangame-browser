import { useState } from "react";
import type { Room } from "colyseus.js";
import { Avatar } from "./Avatar";
import type { Lookup, Me } from "./Chat";
import { sfx } from "./sfx";
import { EXACT_STAR, EXACT_WEIGHT, type PlayerView } from "./net";

const STARS = [1, 2, 3, 4, 5];
const weightText = (w: number) => `${String(w).replace(".", ",")}×`;

/** Estrellas de 1 a 5 (tocar la misma otra vez la quita). */
export function StarPicker({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div className="stars-pick" role="radiogroup">
      {STARS.map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} disabled={disabled}
          className={n <= value ? "on" : ""} onClick={() => onChange(value === n ? 0 : n)}>★</button>
      ))}
    </div>
  );
}

/**
 * 🎯 Exactitud: antes de ver los resultados, todos califican qué tan bien imitaron a cada cuerpo (sin saber todavía
 * quién estaba adentro). Tu voto sobre TU cuerpo vale 2×; sobre los demás, 0,5×. Quien estaba en un cuerpo ajeno
 * gana ★ promedio × 40 puntos.
 */
export function ExactPhase({ room, me, P, players, initial }: {
  room: Room; me: Me; P: Lookup; players: PlayerView[]; initial: Record<string, number>;
}) {
  const [r, setR] = useState<Record<string, number>>(initial);
  const submitted = !!P(me.mindId)?.submitted;
  const connected = players.filter((p) => p.connected);
  const done = connected.filter((p) => p.submitted).length;
  // Tu cuerpo primero: es el voto que más pesa.
  const bodies = [...players].sort((a, b) => Number(b.id === me.mindId) - Number(a.id === me.mindId));
  const rated = Object.values(r).filter(Boolean).length;
  const canRate = (id: string) => id !== me.bodyId;

  function set(body: string, v: number) {
    if (submitted) return;
    sfx.pop();
    setR((prev) => ({ ...prev, [body]: v }));
  }

  return (
    <div className="card exact-phase">
      <div className="vote-head">
        <h2>🎯 Exactitud</h2>
        <span className="muted small">{done}/{connected.length} ya calificaron</span>
      </div>
      <p className="muted">
        ¿Qué tan bien imitaron a cada cuerpo? Tu voto sobre <b>tu propio cuerpo</b> vale <b className="w2">{weightText(EXACT_WEIGHT.owner)}</b>;
        sobre los demás, <b className="w05">{weightText(EXACT_WEIGHT.other)}</b>. Quien estaba en un cuerpo ajeno gana <b>★ promedio × {EXACT_STAR}</b> puntos
        (hasta {5 * EXACT_STAR}). Todavía no se revela quién estaba adentro.
      </p>
      <div className="exact-grid">
        {bodies.map((b) => {
          const mine = b.id === me.mindId;
          const inside = b.id === me.bodyId;
          const w = mine ? EXACT_WEIGHT.owner : EXACT_WEIGHT.other;
          return (
            <div key={b.id} className={"xcard" + (mine ? " mine" : "") + (inside ? " inside" : "") + (b.bodyOut ? " gone" : "")}>
              {canRate(b.id) && <span className={"xweight" + (mine ? " w2" : "")}>{weightText(w)}</span>}
              <Avatar avatar={b.avatar} color={b.color} size={56} />
              <b>{mine ? "Tu cuerpo" : `Cuerpo de ${b.name}`}</b>
              {b.bodyOut && <small className="muted">expulsado</small>}
              {inside ? (
                <small className="muted">{mine ? "🟢 Estabas en tu cuerpo" : "🎭 Estás aquí: no te calificas"}</small>
              ) : (
                <>
                  <small className="muted">{mine ? "¿Te imitaron bien?" : `¿Imitaron bien a ${b.name}?`}</small>
                  <StarPicker value={r[b.id] ?? 0} disabled={submitted} onChange={(v) => set(b.id, v)} />
                </>
              )}
            </div>
          );
        })}
      </div>
      {submitted ? (
        <p className="muted center-text">✅ Listo. Esperando al resto ({done}/{connected.length})…</p>
      ) : (
        <button className={"btn big" + (rated > 0 ? " wiggle" : "")} onClick={() => { sfx.boing(); room.send("rate", { ratings: r }); }}>
          🎯 ENVIAR {rated > 0 ? `(${rated} calificado${rated === 1 ? "" : "s"})` : "sin calificar"}
        </button>
      )}
    </div>
  );
}

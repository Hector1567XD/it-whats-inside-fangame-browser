import { useEffect, useMemo, useState } from "react";
import type { Room } from "colyseus.js";
import confetti from "canvas-confetti";
import { Avatar } from "./Avatar";
import type { Lookup, Me } from "./Chat";
import { sfx } from "./sfx";
import type { GuessResults, ImmutableResults, ResultsPayload } from "./net";

const KIND_LABEL = { UNMASK: "🎭 Desenmascare", VOTE: "🗳️ Votación", FINAL_VOTE: "⚖️ Juicio Final" } as const;

type Props = { P: Lookup; me: Me; isHost: boolean; room: Room; onRevealed: (v: boolean) => void };

export function Results({ data, ...rest }: Props & { data: ResultsPayload | null }) {
  if (!data) return <div className="card"><div className="loader">🥁</div></div>;
  return data.family === "immutable"
    ? <ImmutableResultsView data={data} {...rest} />
    : <GuessResultsView data={data} {...rest} />;
}

/**
 * 1) Revelación cuerpo por cuerpo: qué mente había adentro (o si nadie cambió).
 * 2) Tu ronda: tus adivinanzas vs la verdad y de dónde salió cada punto.
 * 3) Puntos de ESTA ronda. El acumulado se ve en el lobby.
 */
function GuessResultsView({ data, P, me, isHost, room, onRevealed }: Props & { data: GuessResults }) {
  const [shown, setShown] = useState(0);
  const total = data?.results.length ?? 0;
  const allShown = !!data && shown >= total;

  useEffect(() => {
    if (!data || shown >= total) return;
    const t = setTimeout(() => {
      const r = data.results[shown];
      r.swapped ? sfx.reveal() : sfx.pop();
      setShown((n) => n + 1);
    }, shown === 0 ? 2200 : 1300);
    const d = shown > 0 ? setTimeout(() => sfx.drumroll(0.7), 400) : undefined;
    return () => { clearTimeout(t); clearTimeout(d); };
  }, [data, shown]);

  useEffect(() => {
    onRevealed(allShown);
    if (!allShown || total === 0) return;
    sfx.win();
    const end = Date.now() + 1500;
    const burst = () => {
      confetti({ particleCount: 40, angle: 60, spread: 60, origin: { x: 0 } });
      confetti({ particleCount: 40, angle: 120, spread: 60, origin: { x: 1 } });
      if (Date.now() < end) setTimeout(burst, 250);
    };
    burst();
  }, [allShown]);

  const ranking = useMemo(
    () => (data ? [...data.results].sort((a, b) => b.points - a.points) : []),
    [data],
  );

  const swappedN = data.results.filter((r) => r.swapped).length;
  const rivals = data.results.filter((r) => !r.out).length - 1;
  const ejectedAt = Object.fromEntries(data.ejections.map((e) => [e.bodyId, e.cycle]));
  const mine = data.results.find((r) => r.mindId === me.mindId);
  const myGuesses = data.guesses[me.mindId] ?? {};
  const truth = Object.fromEntries(data.results.map((r) => [r.bodyId, r.mindId])); // cuerpo -> mente

  return (
    <div className="results">
      <div className="card">
        <h2>🧳 Lo que había adentro</h2>
        <p className="muted">
          {allShown
            ? data.mode === "classic"
              ? <>Cambiaron <b>{swappedN} de {total}</b>. Los demás siguieron en su propio cuerpo.</>
              : <>Todos cambiaron de cuerpo.</>
            : "Revelando cuerpo por cuerpo…"}
        </p>
        <div className="reveal-grid">
          {data.results.map((r, i) => {
            const body = P(r.bodyId);
            const mind = P(r.mindId);
            const open = i < shown;
            const rightGuesses = data.results.filter(
              (o) => o.mindId !== r.mindId && o.bodyId !== r.bodyId && data.guesses[o.mindId]?.[r.bodyId] === r.mindId,
            ).length;
            return (
              <div key={r.bodyId} className={"rcard" + (open ? " open" : "") + (r.swapped ? " swapped" : " same") + (r.out ? " outcard" : "") + (r.mindId === me.mindId ? " me" : "")}>
                <div className="rc-tag">Cuerpo de</div>
                <Avatar avatar={body?.avatar} color={body?.color ?? "#999"} size={64} />
                <b className="rc-body">{body?.name}</b>
                <div className="flip">
                  <div className="flip-inner">
                    <div className="flip-front">❓</div>
                    <div className="flip-back">
                      {r.swapped ? (
                        <>
                          <span className="rc-arrow">⬇ tenía adentro a</span>
                          <span className="rc-mind">
                            <Avatar avatar={mind?.avatar} color={mind?.color ?? "#999"} size={30} /> <b>{mind?.name}</b>
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="rc-arrow">🟢 nadie cambió</span>
                          <span className="rc-mind"><b>Era {mind?.name}</b></span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                {open && (
                  <div className="rc-foot">
                    {r.out ? `🎭 desenmascarado en el ciclo ${ejectedAt[r.bodyId] ?? "?"}` : `👀 ${rightGuesses}/${rivals} acertaron`}
                    {r.mindId === me.mindId ? " · (tú)" : ""}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {!allShown && <button className="chip" onClick={() => setShown(total)}>Revelar todo ⏩</button>}
      </div>

      {allShown && mine && (
        <div className="card mine-round pop-in">
          <h2>📋 Tu ronda</h2>
          <ul className="my-guesses">
            {mine.early !== 0 && (
              <li className={(mine.early > 0 ? "ok" : "bad") + " bonus"}>
                <span>🎭 <b>Desenmascares</b>: {mine.out ? "te desenmascararon y quedaste de espectador" : "acertaste en una votación entre ciclos"}</span>
                <b className="mg-pts">{mine.early > 0 ? `+${mine.early}` : mine.early}</b>
              </li>
            )}
            {Object.entries(myGuesses).map(([bodyId, guess]) => {
              const real = truth[bodyId];
              const ok = guess === real;
              const pts = ok ? (real === bodyId ? 50 : 200) : 0;
              return (
                <li key={bodyId} className={ok ? "ok" : "bad"}>
                  <Avatar avatar={P(bodyId)?.avatar} color={P(bodyId)?.color ?? "#999"} size={28} />
                  <span>Cuerpo de <b>{P(bodyId)?.name}</b></span>
                  <span className="mg-said">
                    dijiste: <b>{!guess ? "—" : guess === bodyId ? "no cambió" : P(guess)?.name}</b>
                    {!ok && <> · era: <b>{real === bodyId ? "no cambió" : P(real)?.name}</b></>}
                  </span>
                  <b className="mg-pts">{ok ? `✅ +${pts}` : "❌"}</b>
                </li>
              );
            })}
            {!mine.out && <li className={mine.bonus ? "ok bonus" : "bad bonus"}>
              {mine.swapped ? (
                <span>🥷 <b>Sigilo</b>: cambiaste y te descubrieron {mine.guessedBy} de {rivals}
                  {mine.bonus ? " — ¡menos de la mitad!" : " (necesitabas menos de la mitad)"}</span>
              ) : (
                <span>🎭 <b>Despiste</b>: no cambiaste y {mine.fooled} de {rivals} creyeron que sí
                  {mine.bonus ? " — ¡los engañaste!" : " (necesitabas la mitad o más)"}</span>
              )}
              <b className="mg-pts">{mine.bonus ? "✅ +150" : "❌"}</b>
            </li>}
          </ul>
          <div className="my-total">Esta ronda: <b>{mine.points >= 0 ? "+" : ""}{mine.points}</b></div>
        </div>
      )}

      {allShown && (
        <div className="card pop-in">
          <h2>🏅 Puntos de esta ronda</h2>
          <ol className="rank">
            {ranking.map((r, i) => {
              const p = P(r.mindId);
              return (
                <li key={r.mindId} className={"pop-in" + (r.mindId === me.mindId ? " me" : "")} style={{ animationDelay: `${i * 0.1}s` }}>
                  <span className="medal">{["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`}</span>
                  <Avatar avatar={p?.avatar} color={p?.color ?? "#999"} size={30} /> {p?.name}
                  <span className="rank-detail">
                    🎯 {r.hits}{data.mode === "classic" && ` · 🙋 ${r.sameHits}`}
                    {r.bonus === "stealth" && " · 🥷"}{r.bonus === "decoy" && " · 🎭"}
                    {r.early !== 0 && ` · 🎭 ${r.early > 0 ? "+" : ""}${r.early}`}{r.out && " · 👻"}
                  </span>
                  <b>{r.points >= 0 ? "+" : ""}{r.points}</b>
                </li>
              );
            })}
          </ol>
          <p className="muted small">🎯 cambios descubiertos (+200) · 🙋 aciertos de “no cambió” (+50) · 🥷/🎭 bonus (+150). El total acumulado está en la sala de espera.</p>
          {isHost ? <button className="btn big wiggle" onClick={() => room.send("next")}>▶ VOLVER A LA SALA</button>
            : <p className="muted center-text">Esperando al host…</p>}
        </div>
      )}
    </div>
  );
}

// ======================= INMUTABLES =======================

function ImmutableResultsView({ data, P, me, isHost, room, onRevealed }: Props & { data: ImmutableResults }) {
  useEffect(() => {
    sfx.win();
    confetti({ particleCount: 150, spread: 100, origin: { y: 0.4 } });
    const t = setTimeout(() => onRevealed(true), 1200);
    return () => clearTimeout(t);
  }, [data]);

  const imm = P(data.immutableId);
  const iWon = data.winner === "immutable" ? me.mindId === data.immutableId : me.mindId !== data.immutableId;
  const bodyToMind = Object.fromEntries(Object.entries(data.bodies).map(([m, b]) => [b, m]));
  const ranking = Object.entries(data.points).sort((a, b) => b[1] - a[1]);

  return (
    <div className="results">
      <div className={"card winner-card " + data.winner}>
        <div className="winner-title">{data.winner === "changers" ? "🎉 ¡GANAN LOS CAMBIANTES!" : "🗿 ¡GANA EL INMUTABLE!"}</div>
        <div className="imm-reveal">
          <span>El Inmutable era</span>
          <Avatar avatar={imm?.avatar} color={imm?.color ?? "#999"} size={88} className="wobble" />
          <b>{imm?.name}</b>
        </div>
        <p className="muted">{iWon ? "¡Tu equipo ganó! 🥳" : "Esta vez perdiste 😅"}</p>
      </div>

      <div className="card">
        <h2>🗳️ Expulsiones</h2>
        {data.ejections.length === 0 ? <p className="muted">No expulsaron a nadie.</p> : (
          <ol className="ejections">
            {data.ejections.map((e, i) => (
              <li key={i} className={e.wasImmutable ? "imm" : ""}>
                <span className="muted small">Ciclo {e.cycle} · {KIND_LABEL[e.kind]}</span>
                <span>
                  Cuerpo de <b>{P(e.bodyId)?.name}</b> → adentro estaba <b>{P(e.mindId)?.name}</b>
                  {e.wasImmutable ? " 🗿 (el Inmutable)" : " (cambiante)"}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="card">
        <h2>🧳 Quién estaba en cada cuerpo al final</h2>
        <div className="reveal-grid">
          {Object.keys(bodyToMind).map((bodyId) => {
            const mindId = bodyToMind[bodyId];
            const body = P(bodyId);
            const mind = P(mindId);
            const path = (data.history[mindId] ?? []).map((b) => P(b)?.name).join(" → ");
            return (
              <div key={bodyId} className={"rcard open" + (mindId === data.immutableId ? " same" : " swapped") + (body?.bodyOut ? " outcard" : "") + (mindId === me.mindId ? " me" : "")}>
                <div className="rc-tag">Cuerpo de</div>
                <Avatar avatar={body?.avatar} color={body?.color ?? "#999"} size={56} />
                <b className="rc-body">{body?.name}</b>
                <span className="rc-arrow">{mindId === data.immutableId ? "🗿 el Inmutable" : "⬇ tenía adentro a"}</span>
                <span className="rc-mind"><Avatar avatar={mind?.avatar} color={mind?.color ?? "#999"} size={26} /> <b>{mind?.name}</b></span>
                {mindId !== data.immutableId && path && <div className="rc-foot">Recorrido de {mind?.name}: {path}</div>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <h2>🏅 Puntos de esta ronda</h2>
        <ol className="rank">
          {ranking.map(([id, pts], i) => {
            const p = P(id);
            return (
              <li key={id} className={"pop-in" + (id === me.mindId ? " me" : "")} style={{ animationDelay: `${i * 0.1}s` }}>
                <span className="medal">{["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`}</span>
                <Avatar avatar={p?.avatar} color={p?.color ?? "#999"} size={30} /> {p?.name}
                <span className="rank-detail">{id === data.immutableId ? "🗿 Inmutable" : "🔀 cambiante"}{p?.out ? " · 👻" : ""}</span>
                <b>{pts >= 0 ? "+" : ""}{pts}</b>
              </li>
            );
          })}
        </ol>
        <p className="muted small">Inmutable: +500 si gana, +100 por cada cambiante expulsado y +100 por cada votación que sobrevive. Cambiantes: +150 si ganan, +200 extra si votaste por el Inmutable, −50 si votaste por un cambiante que expulsaron.</p>
        {isHost ? <button className="btn big wiggle" onClick={() => room.send("next")}>▶ VOLVER A LA SALA</button>
          : <p className="muted center-text">Esperando al host…</p>}
      </div>
    </div>
  );
}

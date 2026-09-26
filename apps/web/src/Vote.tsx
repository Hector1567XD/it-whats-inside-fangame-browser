import { useEffect, useState } from "react";
import type { Room } from "colyseus.js";
import confetti from "canvas-confetti";
import { Avatar } from "./Avatar";
import type { Lookup, Me } from "./Chat";
import { sfx } from "./sfx";
import { REACTIONS, activeCount, type PlayerView, type Role, type StateView, type Verdict } from "./net";

export type Floater = { id: number; target: string; emoji: string; x: number };

// ======================= REACCIONES =======================

export function Floaters({ items, target }: { items: Floater[]; target: string }) {
  return (
    <div className="floaters" aria-hidden>
      {items.filter((f) => f.target === target).map((f) => (
        <span key={f.id} style={{ left: `${f.x}%` }}>{f.emoji}</span>
      ))}
    </div>
  );
}

export function ReactBar({ onReact, disabled }: { onReact: (emoji: string) => void; disabled?: boolean }) {
  return (
    <div className="react-bar">
      {REACTIONS.map((e) => (
        <button key={e} type="button" disabled={disabled} onClick={(ev) => { ev.stopPropagation(); onReact(e); }}>{e}</button>
      ))}
    </div>
  );
}

export function SpectatorNote() {
  return <div className="spectator-note">👻 Te expulsaron. Estás mirando: puedes leer el chat público, pero no escribir, votar ni ver chats privados.</div>;
}

// ======================= 🎭 EL DESENMASCARE / 🗳️ LA VOTACIÓN / ⚖️ JUICIO FINAL =======================

export function VotePhase({ room, s, me, role, P, players, floats, react }: {
  room: Room; s: StateView; me: Me; role: Role; P: Lookup; players: PlayerView[];
  floats: Floater[]; react: (target: string, emoji: string) => void;
}) {
  const unmask = s.phase === "UNMASK";
  const final = s.phase === "FINAL_VOTE";
  const iAmOut = !!me.spectator;
  const submitted = !!P(me.mindId)?.submitted;
  const done = players.filter((p) => !p.out && p.submitted).length;
  const total = activeCount(players); // por cuerpos: cuenta bien aunque haya fantasmas
  const bodies = players.filter((p) => !p.bodyOut && p.id !== me.bodyId);
  const minds = players.filter((p) => !p.out && p.id !== me.mindId);
  const allowSame = s.settings.mode === "classic" && s.settings.unmaskSame;
  const [body, setBody] = useState("");
  const [mind, setMind] = useState("");

  function pickBody(id: string) {
    if (submitted || iAmOut) return;
    sfx.pop();
    setBody(id === body ? "" : id);
    setMind("");
  }
  function send() {
    sfx.boing();
    if (unmask) room.send("accuse", { body, mind });
    else room.send("vote", { body });
  }
  function skip() {
    sfx.click();
    room.send(unmask ? "accuse" : "vote", { skip: true });
  }

  const title = unmask ? "🎭 El Desenmascare" : final ? "⚖️ Juicio Final" : "🗳️ La Votación";
  const need = Math.ceil(0.6 * Math.max(1, total - 1));
  const help = unmask
    ? <>Acusa <b>un</b> cuerpo y di qué mente hay adentro. Si <b>{need} de {total - 1}</b> aciertan la misma acusación, esa mente queda desenmascarada (−200) y quienes acertaron ganan +200. El conteo no se muestra.</>
    : final
      ? <>Última oportunidad. Si sale el Inmutable, <b>ganan los cambiantes</b>; si no sale nadie o sale un cambiante, <b>gana el Inmutable</b>.</>
      : <>Sale el cuerpo con más votos, aunque sea 1. Empate, o si gana ⏭ Omitir: no sale nadie.</>;
  const roleHint = role === "immutable"
    ? "🗿 Eres el Inmutable: haz que expulsen a un cambiante."
    : role === "changer" ? "🔀 Eres cambiante: vota por el cuerpo que crees que nunca cambió." : null;

  return (
    <div className={"card vote-phase" + (final ? " final" : "")}>
      <div className="vote-head">
        <h2>{title}</h2>
        <span className="muted small">{done}/{total} ya {unmask ? "acusaron" : "votaron"}</span>
      </div>
      <p className="muted">{help}</p>
      {roleHint && !iAmOut && <div className="role-hint">{roleHint}</div>}
      {iAmOut && <SpectatorNote />}
      <div className="vote-grid">
        {bodies.map((b) => {
          const sel = body === b.id;
          return (
            <div key={b.id} role="button" tabIndex={0} className={"vcard" + (sel ? " on" : "") + (submitted || iAmOut ? " locked" : "")}
              onClick={() => pickBody(b.id)} onKeyDown={(e) => e.key === "Enter" && pickBody(b.id)}>
              <Floaters items={floats} target={b.id} />
              <Avatar avatar={b.avatar} color={b.color} size={64} />
              <b>{unmask ? `Cuerpo de ${b.name}` : b.name}</b>
              {unmask && sel && (
                <div className="mind-chips" onClick={(e) => e.stopPropagation()}>
                  {allowSame && b.id !== me.mindId && !P(b.id)?.out && (
                    <button type="button" className={"mchip same" + (mind === b.id ? " on" : "")} onClick={() => { sfx.pop(); setMind(b.id); }}>🙋 No cambió</button>
                  )}
                  {minds.filter((m) => m.id !== b.id).map((m) => (
                    <button type="button" key={m.id} className={"mchip" + (mind === m.id ? " on" : "")} onClick={() => { sfx.pop(); setMind(m.id); }}>{m.name}</button>
                  ))}
                </div>
              )}
              {!iAmOut && <ReactBar onReact={(e) => react(b.id, e)} />}
            </div>
          );
        })}
      </div>
      {iAmOut ? null : submitted ? (
        <p className="muted center-text">✅ Listo. Esperando al resto ({done}/{total})…</p>
      ) : (
        <div className="vote-actions">
          <button className="btn big" disabled={!body || (unmask && !mind)} onClick={send}>
            {!body ? (unmask ? "Elige un cuerpo" : "Elige a quién expulsar")
              : unmask ? (mind ? `🎭 Acusar: en ${P(body)?.name} está ${mind === body ? `${P(body)?.name} mismo` : P(mind)?.name}` : "Elige la mente")
                : `🗳️ Votar por ${P(body)?.name}`}
          </button>
          <button className="btn skip" onClick={skip}>⏭ Omitir</button>
        </div>
      )}
    </div>
  );
}

// ======================= ANUNCIO DEL RESULTADO =======================

export function VerdictScreen({ v, P, me, floats, react }: {
  v: Verdict | null; P: Lookup; me: Me; floats: Floater[]; react: (target: string, emoji: string) => void;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    if (!v) return;
    sfx.drumroll(1.4);
    const t = setTimeout(() => {
      setShown(true);
      if (v.outcome === "ejected") { sfx.slam(); setTimeout(() => sfx.reveal(), 150); } else sfx.fail();
      if (v.winner) {
        sfx.win();
        confetti({ particleCount: 160, spread: 100, origin: { y: 0.5 } });
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [v]);

  if (!v) return <div className="verdict"><div className="loader">⚖️</div></div>;
  const body = v.bodyId ? P(v.bodyId) : undefined;
  const mind = v.mindId ? P(v.mindId) : undefined;
  const iAmOut = !!me.spectator;
  // En un fantasma no viene la mente; si el cuerpo expulsado era el mío, era yo.
  const mine = v.mindId === me.mindId || (!!v.ghost && v.bodyId === me.bodyId);

  let headline = "";
  let sub = "";
  if (v.kind === "UNMASK") {
    if (v.outcome === "ejected") {
      headline = `¡El cuerpo de ${body?.name} fue desenmascarado!`;
      sub = v.wasSame ? `Nadie lo había cambiado: era ${mind?.name} mismo. −150 para ${mind?.name}.` : `Adentro estaba ${mind?.name}. −200 para ${mind?.name}, +200 para quienes acertaron.`;
    } else {
      headline = "Nadie fue desenmascarado";
      sub = "Ningún cuerpo llegó al 60% de aciertos.";
    }
  } else if (v.outcome === "ejected") {
    headline = v.ghost ? `👻 El cuerpo de ${body?.name} ahora es un fantasma` : `Expulsaron el cuerpo de ${body?.name}`;
    sub = v.wasImmutable
      ? `¡Adentro estaba ${mind?.name}, EL INMUTABLE! 🗿`
      : v.ghost
        ? "No era el Inmutable… y no sabremos qué alma tenía adentro hasta el final. La partida sigue."
        : `Adentro estaba ${mind?.name}. Era un cambiante 😬`;
  } else {
    headline = "No se sacó a nadie";
    sub = v.reason === "tie" ? "Hubo empate." : v.reason === "skip" ? "Ganó ⏭ Omitir." : "Nadie votó.";
  }

  const tally = Object.entries(v.tally ?? {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...tally.map(([, n]) => n));

  return (
    <div className={"verdict" + (shown ? " shown" : "")}>
      <Floaters items={floats} target="verdict" />
      {!shown ? (
        <h1 className="verdict-suspense pulse">{v.kind === "UNMASK" ? "🎭" : "⚖️"} El resultado…</h1>
      ) : (
        <div className="verdict-card">
          {body && v.outcome === "ejected" && (
            <div className="verdict-faces">
              <Avatar avatar={body.avatar} color={body.color} size={96} className="wobble" />
              {mind && mind.id !== body.id && <><span className="verdict-arrow">➜</span><Avatar avatar={mind.avatar} color={mind.color} size={72} /></>}
            </div>
          )}
          <h1 className="verdict-title">{headline}</h1>
          <p className="verdict-sub">{sub}</p>
          {mine && <p className="verdict-you">👻 Eras tú. Desde ahora eres espectador.</p>}
          {tally.length > 0 && (
            <div className="tally">
              {tally.map(([k, n]) => (
                <div key={k} className="tally-row">
                  <span className="tally-name">{k === "skip" ? "⏭ Omitir" : P(k)?.name}</span>
                  <span className="tally-bar"><span style={{ width: `${(n / max) * 100}%` }} /></span>
                  <b className="tally-n">{n}</b>
                </div>
              ))}
            </div>
          )}
          {v.winner && (
            <div className={"winner " + v.winner}>{v.winner === "changers" ? "🎉 ¡GANAN LOS CAMBIANTES!" : "🗿 ¡GANA EL INMUTABLE!"}</div>
          )}
        </div>
      )}
      {!iAmOut && <ReactBar onReact={(e) => react("verdict", e)} />}
    </div>
  );
}

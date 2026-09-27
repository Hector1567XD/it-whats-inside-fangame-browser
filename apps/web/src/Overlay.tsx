import { useEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { Avatar } from "./Avatar";
import { sfx } from "./sfx";
import { channels, type PlayerView, type Role, type StateView } from "./net";

type Banner = {
  kind: "QUESTION" | "THREAD" | "DAY" | "NIGHT" | "RADIO" | "UNMASK" | "VOTE" | "GUESS" | "FINAL_VOTE" | "EXACT" | "RESULTS";
  title: string; sub: string; ms: number; chats?: boolean;
};

/** Letrero gigante animado cada vez que cambia la fase. */
export function PhaseBanner({ s, bodyName }: { s: StateView; bodyName: string }) {
  const [b, setB] = useState<(Banner & { key: string }) | null>(null);
  const key = `${s.phase}-${s.cycle}-${s.round}`;
  const first = useRef(true);

  useEffect(() => {
    const wasFirst = first.current;
    first.current = false;
    let banner: Banner | null = null;
    const cyc = s.totalCycles > 1 ? ` ${s.cycle}` : "";
    if (s.phase === "QUESTION") {
      banner = { kind: "QUESTION", title: "LA PREGUNTA", sub: `Responde como ${bodyName}… o como tú 😏`, ms: 2600 };
      sfx.guess();
    } else if (s.phase === "THREAD") {
      banner = { kind: "THREAD", title: "EL HILO", sub: "Todos a cotorrear cada respuesta 🦜", ms: 2600 };
      sfx.day();
    } else if (s.phase === "DAY") {
      banner = { kind: "DAY", title: `CHAT GLOBAL${cyc}`, sub: `Todos te ven como ${bodyName}`, ms: 2600 };
      sfx.day();
    } else if (s.phase === "NIGHT") {
      const n = s.chatLimit;
      const ch = channels(s.settings, "NIGHT", s.sfu);
      const chats = `Solo puedes INICIAR ${n} chat${n === 1 ? "" : "s"} privado${n === 1 ? "" : "s"}`;
      banner = !ch.text
        ? { kind: "RADIO", title: `LLAMADA DE RADIO${cyc}`, sub: "Llamadas 1 a 1 ilimitadas: contesta o rechaza 📻", ms: 3000 }
        : ch.voice
          ? { kind: "NIGHT", title: `CHAT PRIVADO + RADIO${cyc}`, sub: `${chats} · 📻 radio ilimitada`, ms: 3400, chats: true }
          : { kind: "NIGHT", title: `CHAT PRIVADO${cyc}`, sub: `${chats} 🤫`, ms: 3400, chats: true };
      sfx.night();
    } else if (s.phase === "RADIO") {
      banner = { kind: "RADIO", title: `LLAMADA DE RADIO${cyc}`, sub: "Llamadas 1 a 1 ilimitadas: contesta o rechaza 📻", ms: 3000 };
      sfx.night();
    } else if (s.phase === "UNMASK") {
      banner = { kind: "UNMASK", title: "EL DESENMASCARE", sub: "Acusa: ¿qué mente hay en qué cuerpo? 🎭", ms: 2600 };
      sfx.guess();
    } else if (s.phase === "VOTE") {
      banner = { kind: "VOTE", title: "LA VOTACIÓN", sub: "¿Quién nunca cambió? Vota o ⏭ omite 🗳️", ms: 2600 };
      sfx.guess();
    } else if (s.phase === "FINAL_VOTE") {
      banner = { kind: "FINAL_VOTE", title: "JUICIO FINAL", sub: "Última votación: ¿quién es el Inmutable? ⚖️", ms: 2800 };
      sfx.guess();
    } else if (s.phase === "GUESS") {
      banner = { kind: "GUESS", title: "¿QUIÉN ES QUIÉN?", sub: "Adivina qué mente hay en cada cuerpo", ms: 2600 };
      sfx.guess();
    } else if (s.phase === "EXACT") {
      banner = { kind: "EXACT", title: "EXACTITUD", sub: "¿Qué tan bien imitaron a cada cuerpo? Tu cuerpo vale 2× 🎯", ms: 2800 };
      sfx.guess();
    } else if (s.phase === "RESULTS") {
      banner = { kind: "RESULTS", title: "¡REVELACIÓN!", sub: "Veamos lo que hay adentro… 🧳", ms: 2000 };
      sfx.drumroll(1.6);
    }
    if (!banner || (wasFirst && s.timer > 0 && s.timer < 10)) return setB(null);
    setB({ ...banner, key });
    const t = setTimeout(() => setB(null), banner.ms);
    return () => clearTimeout(t);
  }, [key]);

  if (!b) return null;
  return (
    <div key={b.key} className={"banner banner-" + b.kind} onClick={() => setB(null)} style={{ animationDuration: `${b.ms}ms` }}>
      <div className="banner-deco">
        {b.kind === "DAY" && <div className="sunrays" />}
        {b.kind === "DAY" && <div className="sun">☀️</div>}
        {(b.kind === "NIGHT" || b.kind === "RADIO") && <Stars n={40} />}
        {b.kind === "NIGHT" && <div className="moon">🌙</div>}
        {b.kind === "RADIO" && <div className="moon">📻</div>}
        {b.kind === "EXACT" && <><div className="sunrays" /><div className="lens">🎯</div></>}
        {b.kind === "GUESS" && <div className="lens">🧩</div>}
        {b.kind === "UNMASK" && <div className="lens">🎭</div>}
        {b.kind === "VOTE" && <div className="lens">🗳️</div>}
        {b.kind === "FINAL_VOTE" && <><div className="sunrays" /><div className="lens">⚖️</div></>}
        {b.kind === "QUESTION" && <div className="lens">❓</div>}
        {b.kind === "THREAD" && <><div className="sunrays" /><div className="lens">🦜</div></>}
        {b.kind === "RESULTS" && <div className="lens">🥁</div>}
      </div>
      <h1 className="banner-title">{b.title}</h1>
      <p className="banner-sub">{b.sub}</p>
      {b.chats && (
        <div className="banner-chats">
          {Array.from({ length: s.chatLimit }, (_, i) => <span key={i} style={{ animationDelay: `${0.7 + i * 0.15}s` }}>💬</span>)}
        </div>
      )}
    </div>
  );
}

export function Stars({ n }: { n: number }) {
  const [stars] = useState(() =>
    Array.from({ length: n }, () => ({ l: Math.random() * 100, t: Math.random() * 100, d: Math.random() * 3, s: 2 + Math.random() * 3 })),
  );
  return (
    <div className="stars">
      {stars.map((x, i) => (
        <i key={i} style={{ left: `${x.l}%`, top: `${x.t}%`, animationDelay: `${x.d}s`, width: x.s, height: x.s }} />
      ))}
    </div>
  );
}

/** Fase SWAP: la ruleta de cuerpos que termina en tu nuevo cuerpo. */
export function SwapScreen({ players: all, mind, body, spectator, timer, role, reswap }: {
  players: PlayerView[]; mind?: PlayerView; body?: PlayerView; spectator: boolean; timer: number; role: Role; reswap: boolean;
}) {
  const players = all.filter((p) => !p.bodyOut);
  if (spectator) {
    return (
      <div className="swap">
        <h1 className="swap-title">🧳 ¡RE-CAMBIO!</h1>
        <p className="swap-now">👻 Los demás cambian de cuerpo… tú solo miras.</p>
      </div>
    );
  }
  return <SwapRoulette players={players} mind={mind} body={body} timer={timer} role={role} reswap={reswap} />;
}

function SwapRoulette({ players, mind, body, timer, role, reswap }: {
  players: PlayerView[]; mind?: PlayerView; body?: PlayerView; timer: number; role: Role; reswap: boolean;
}) {
  const [idx, setIdx] = useState(0);
  const [landed, setLanded] = useState(false);
  const target = Math.max(0, players.findIndex((p) => p.id === body?.id));

  useEffect(() => {
    if (!body) return;
    sfx.swap();
    let i = 0;
    let delay = 70;
    let t: ReturnType<typeof setTimeout>;
    const total = players.length * 3 + target; // unas vueltas y cae en el cuerpo correcto
    const step = () => {
      i++;
      setIdx(i % players.length);
      if (i % 2 === 0) sfx.tick();
      if (i >= total) {
        setLanded(true);
        sfx.land();
        confetti({ particleCount: 120, spread: 90, origin: { y: 0.55 }, colors: [body.color, "#ffd23d", "#ffffff"] });
        return;
      }
      if (i > total - 7) delay *= 1.35;
      t = setTimeout(step, delay);
    };
    t = setTimeout(step, 900);
    return () => clearTimeout(t);
  }, [body?.id]);

  return (
    <div className="swap">
      <h1 className="swap-title">{reswap ? "🧳 ¡RE-CAMBIO!" : "🧳 ¡LA MÁQUINA ESTÁ LISTA!"}</h1>
      {mind && (
        <p className="swap-mind">
          Tu mente: <Avatar avatar={mind.avatar} color={mind.color} size={32} /> <b>{mind.name}</b> … sale volando 👻
        </p>
      )}
      <div className={"swap-ring" + (landed ? " landed" : "")}>
        {players.map((p, i) => (
          <div key={p.id} className={"swap-cell" + (i === idx ? " on" : "") + (landed && i === target ? " win" : "")}>
            <Avatar avatar={p.avatar} color={p.color} size={64} />
            <span>{p.name}</span>
          </div>
        ))}
      </div>
      {landed && body && role === "immutable" ? (
        <div className="swap-result">
          <div className="swap-now">🗿 Eres EL INMUTABLE</div>
          <Avatar avatar={body.avatar} color={body.color} size={120} className="wobble" />
          <div className="swap-body">Te quedas en tu cuerpo</div>
          <p className="swap-tip">Los demás {reswap ? "volvieron a cambiar" : "cambiaron"} de cuerpo. Actúa como si también cambiaras y haz que expulsen a los cambiantes. Ganas si sobrevives al <b>⚖️ Juicio Final</b>.</p>
          <p className="muted">Empieza en {timer}s…</p>
        </div>
      ) : landed && body && role === "changer" ? (
        <div className="swap-result">
          <div className="swap-now">🔀 Eres cambiante. {reswap ? "Nuevo cuerpo:" : "Ahora estás en el cuerpo de"}</div>
          <Avatar avatar={body.avatar} color={body.color} size={120} className="wobble" />
          <div className="swap-body">{body.name}</div>
          <p className="swap-tip">Uno de los jugadores <b>nunca cambia</b>: el Inmutable. Descúbrelo y vótalo antes del final. 🕵️</p>
          <p className="muted">Empieza en {timer}s…</p>
        </div>
      ) : landed && body && body.id === mind?.id ? (
        <div className="swap-result">
          <div className="swap-now">🟢 ¡La máquina te devolvió a tu cuerpo!</div>
          <Avatar avatar={body.avatar} color={body.color} size={120} className="wobble" />
          <div className="swap-body">Sigues siendo {body.name}</div>
          <p className="swap-tip">Otros sí cambiaron (no sabes cuántos). Si logras que la mitad crea que cambiaste, ganas <b>+150 🎭 Despiste</b>.</p>
          <p className="muted">Empieza en {timer}s…</p>
        </div>
      ) : landed && body ? (
        <div className="swap-result">
          <div className="swap-now">✅ Transferencia completa. Ahora estás en el cuerpo de</div>
          <Avatar avatar={body.avatar} color={body.color} size={120} className="wobble" />
          <div className="swap-body">{body.name}</div>
          <p className="swap-tip">Actúa como <b>{body.name}</b> durante toda la partida. ¡Que nadie sepa que eres tú! 🤐</p>
          <p className="muted">Empieza en {timer}s…</p>
        </div>
      ) : <p className="swap-now pulse">⚡ Iniciando la transferencia…</p>}
    </div>
  );
}

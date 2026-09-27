import { useMemo, useState } from "react";
import { Avatar, avatarUri } from "./Avatar";
import type { Lookup } from "./Chat";
import { sfx } from "./sfx";
import { download, fileName, fmtSec, graphImage, threadImage } from "./snapshot";
import type { NightEdge, PlayerView, ResultsPayload, RoundDetails, ThreadLogPost } from "./net";

type Tab = "awards" | "nights" | "threads" | "votes";
const KIND = { UNMASK: "🎭 El Desenmascare", VOTE: "🗳️ La Votación", FINAL_VOTE: "⚖️ Juicio Final" } as const;

/** Qué mente estaba en cada cuerpo en el ciclo `cycle` (según el recorrido de cada una). */
function mindsAt(d: RoundDetails, cycle: number) {
  const out: Record<string, string> = {};
  for (const [mind, bodies] of Object.entries(d.history)) {
    const b = bodies[Math.min(Math.max(0, cycle - 1), bodies.length - 1)];
    if (b) out[b] = mind;
  }
  return out;
}

/**
 * 📜 Detalles de la ronda (los ven todos al final): premios, 🕸️ chats privados de cada noche, 🦜 hilos de Cotorra
 * con quién escribió qué de verdad y 🗳️ quién votó a quién. Los grafos y los hilos se descargan como imagen.
 */
export function RoundDetailsView({ data, P, players }: { data: ResultsPayload; P: Lookup; players: PlayerView[] }) {
  const d = data.details;
  const [tab, setTab] = useState<Tab>("awards");
  const tabs: [Tab, string, number][] = [
    ["awards", "🏅 Premios", 1],
    ["nights", "🕸️ Chats privados", d.nights.length],
    ["threads", "🦜 Hilos", d.threads.length],
    ["votes", "🗳️ Votos", d.votes.length],
  ];
  return (
    <div className="card details pop-in">
      <h2>📜 Detalles de la ronda</h2>
      <div className="tabs">
        {tabs.filter(([, , n]) => n > 0).map(([id, label]) => (
          <button key={id} className={"tab" + (tab === id ? " on" : "")} onClick={() => { sfx.click(); setTab(id); }}>{label}</button>
        ))}
      </div>
      {tab === "awards" && <Awards data={data} P={P} />}
      {tab === "nights" && <Nights d={d} P={P} players={players} />}
      {tab === "threads" && <Threads d={d} P={P} />}
      {tab === "votes" && <Votes d={d} P={P} />}
    </div>
  );
}

// ======================= 🏅 PREMIOS =======================

type Award = { icon: string; title: string; who: string; detail: string };

function computeAwards(data: ResultsPayload, P: Lookup): Award[] {
  const d = data.details;
  const out: Award[] = [];
  const name = (id: string) => P(id)?.name ?? "?";
  const top = <T,>(list: T[], score: (x: T) => number) => {
    let best: T | undefined;
    for (const x of list) if (score(x) > 0 && (!best || score(x) > score(best))) best = x;
    return best;
  };

  const chat = top(Object.entries(d.chat), ([, n]) => n);
  if (chat) out.push({ icon: "🗣️", title: "Lengua suelta", who: chat[0], detail: `${chat[1]} mensaje${chat[1] === 1 ? "" : "s"} en los chats de la partida` });

  // Pares y totales por mente, sumando todas las noches
  const pairs = new Map<string, { a: string; b: string; n: number; sec: number }>();
  const partners = new Map<string, Set<string>>();
  const radio = new Map<string, number>();
  const privateMsgs = new Map<string, number>();
  for (const night of d.nights) {
    for (const e of night.edges) {
      const k = [e.aMind, e.bMind].sort().join("|");
      const p = pairs.get(k) ?? { a: e.aMind, b: e.bMind, n: 0, sec: 0 };
      p.n += e.dms + e.calls;
      p.sec += e.callSec;
      pairs.set(k, p);
      for (const [m, o] of [[e.aMind, e.bMind], [e.bMind, e.aMind]]) {
        (partners.get(m) ?? partners.set(m, new Set()).get(m)!).add(o);
        radio.set(m, (radio.get(m) ?? 0) + e.callSec);
        privateMsgs.set(m, (privateMsgs.get(m) ?? 0) + e.dms + e.calls);
      }
    }
  }
  const couple = top([...pairs.values()], (p) => p.n);
  if (couple) {
    out.push({ icon: "💘", title: "Inseparables", who: couple.a, detail: `${name(couple.a)} y ${name(couple.b)}: ${couple.n} mensajes/llamadas${couple.sec ? ` · 📻 ${fmtSec(couple.sec)}` : ""}` });
  }
  const social = top([...partners], ([, s]) => s.size);
  if (social) out.push({ icon: "🦋", title: "Mariposa social", who: social[0], detail: `habló en privado con ${social[1].size} personas distintas` });
  const dj = top([...radio], ([, s]) => s);
  if (dj) out.push({ icon: "📻", title: "La voz de la radio", who: dj[0], detail: `${fmtSec(dj[1])} en Llamadas de radio` });

  const posts = d.threads.flatMap((t) => t.posts.flatMap((p) => [p, ...p.replies]));
  const liked = top(posts, (p) => p.likes);
  if (liked) out.push({ icon: "🦜", title: "Cotorreo estrella", who: liked.mind, detail: `“${cut(liked.text, 70)}” · ❤️ ${liked.likes}${liked.mind !== liked.body ? ` (como ${name(liked.body)})` : ""}` });
  const sus = top(posts, (p) => p.sus);
  if (sus) out.push({ icon: "🤨", title: "Cotorreo más sospechoso", who: sus.mind, detail: `“${cut(sus.text, 70)}” · 🤨 ${sus.sus}` });

  const exact = top(data.exact ?? [], (e) => (e.mindId !== e.bodyId ? e.avg : 0));
  if (exact) out.push({ icon: "🎯", title: "Imitación perfecta", who: exact.mindId, detail: `imitó a ${name(exact.bodyId)} con ★ ${exact.avg.toFixed(1)}` });

  const guess = data.family === "guess" ? data.results : data.guess?.results;
  if (guess) {
    const detective = top(guess, (r) => r.hits);
    if (detective) out.push({ icon: "🕵️", title: "Detective", who: detective.mindId, detail: `descubrió ${detective.hits} cambio${detective.hits === 1 ? "" : "s"}` });
    const ninja = guess.filter((r) => r.swapped && !r.out).sort((a, b) => a.guessedBy - b.guessedBy)[0];
    if (ninja) out.push({ icon: "🥷", title: "Maestro del disfraz", who: ninja.mindId, detail: `en el cuerpo de ${name(ninja.bodyId)}: ${ninja.guessedBy === 0 ? "nadie acertó" : `solo ${ninja.guessedBy} acertaron`} quién era` });
  }

  // El más callado: quien menos habló (chats, privados y cotorreos)
  const cotorreos = new Map<string, number>();
  for (const p of posts) cotorreos.set(p.mind, (cotorreos.get(p.mind) ?? 0) + 1);
  const quiet = Object.keys(d.history)
    .map((m) => [m, (d.chat[m] ?? 0) + (privateMsgs.get(m) ?? 0) + (cotorreos.get(m) ?? 0)] as const)
    .sort((a, b) => a[1] - b[1])[0];
  if (quiet && Object.keys(d.history).length > 2) out.push({ icon: "🤐", title: "Modo silencio", who: quiet[0], detail: quiet[1] === 0 ? "no dijo ni una palabra" : `solo ${quiet[1]} mensaje${quiet[1] === 1 ? "" : "s"} en toda la ronda` });
  return out;
}

const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "…" : t);

function Awards({ data, P }: { data: ResultsPayload; P: Lookup }) {
  const awards = useMemo(() => computeAwards(data, P), [data]);
  if (awards.length === 0) return <p className="muted center-text">Ronda tranquila: no hay premios esta vez 🦗</p>;
  return (
    <div className="awards">
      {awards.map((a, i) => {
        const p = P(a.who);
        return (
          <div key={a.title} className="award pop-in" style={{ animationDelay: `${i * 0.07}s` }}>
            <span className="award-icon">{a.icon}</span>
            <div>
              <small>{a.title}</small>
              <b><Avatar avatar={p?.avatar} color={p?.color ?? "#999"} size={24} /> {p?.name ?? "?"}</b>
              <span className="muted">{a.detail}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ======================= 🕸️ CHATS PRIVADOS =======================

function Nights({ d, P, players }: { d: RoundDetails; P: Lookup; players: PlayerView[] }) {
  const [reveal, setReveal] = useState(true);
  const bodies = players.map((p) => p.id);
  return (
    <div className="details-list">
      <button type="button" className="toggle" aria-pressed={reveal} onClick={() => { sfx.click(); setReveal(!reveal); }}>
        <span className="box" /> <span>🧠 Mostrar quién estaba adentro de cada cuerpo</span>
      </button>
      {d.nights.map((n) => {
        const minds = mindsAt(d, n.cycle);
        const title = d.nights.length > 1 ? `Noche ${n.cycle}` : "La noche";
        return (
          <div key={n.cycle} className="night-log">
            <div className="details-head">
              <h3>🕸️ {title}</h3>
              <button className="chip" onClick={async () => {
                sfx.click();
                download(await graphImage({ title: `🕸️ ${title}`, bodies, edges: n.edges, P, minds: reveal ? minds : undefined }), fileName("grafo", title));
              }}>⬇️ Descargar imagen</button>
            </div>
            <StaticGraph bodies={bodies} edges={n.edges} P={P} minds={reveal ? minds : undefined} />
            <ul className="cg-list">
              {[...n.edges].sort((a, b) => b.dms + b.calls - (a.dms + a.calls)).map((e) => (
                <li key={e.aMind + e.bMind}>
                  <b>{P(e.aBody)?.name}</b> ↔ <b>{P(e.bBody)?.name}</b>
                  {reveal && <span className="muted"> ({P(e.aMind)?.name} y {P(e.bMind)?.name})</span>}
                  <span className="muted">
                    {e.dms > 0 && ` · 💬 ${e.dms} mensaje${e.dms === 1 ? "" : "s"}`}
                    {e.calls > 0 && ` · 📻 ${e.calls} llamada${e.calls === 1 ? "" : "s"} (${fmtSec(e.callSec)})`}
                  </span>
                </li>
              ))}
              {n.edges.length === 0 && <li className="muted">🤫 Nadie habló en privado esa noche.</li>}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** El grafo de una noche ya terminada (sin animaciones). Punteado = solo 📻 Llamadas de radio. */
function StaticGraph({ bodies, edges, P, minds }: { bodies: string[]; edges: NightEdge[]; P: Lookup; minds?: Record<string, string> }) {
  const size = 440;
  const c = size / 2;
  const r = size / 2 - 70;
  const pos = new Map(bodies.map((id, i) => {
    const a = (i / bodies.length) * Math.PI * 2 - Math.PI / 2;
    return [id, { x: c + r * Math.cos(a), y: c + r * Math.sin(a) }];
  }));
  const max = Math.max(1, ...edges.map((e) => e.dms + e.calls));
  return (
    <div className="cgraph-wrap">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Grafo de chats privados">
        {edges.map((e) => {
          const a = pos.get(e.aBody);
          const b = pos.get(e.bBody);
          if (!a || !b) return null;
          return (
            <line key={e.aMind + e.bMind} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={"cg-edge" + (e.dms === 0 ? " radio" : "")}
              strokeWidth={2 + 10 * ((e.dms + e.calls) / max)} />
          );
        })}
        {bodies.map((id) => {
          const at = pos.get(id)!;
          const p = P(id);
          const talking = edges.some((e) => e.aBody === id || e.bBody === id);
          const mind = minds?.[id];
          return (
            <g key={id} className={"cg-node" + (talking ? " talking" : "")} transform={`translate(${at.x} ${at.y})`}>
              <circle r={30} fill={p?.color ?? "#999"} className="cg-ring" />
              <image href={avatarUri(p?.avatar ?? "")} x={-25} y={-25} width={50} height={50} />
              <text y={48} textAnchor="middle" className="cg-name">{p?.name}</text>
              {mind && <text y={64} textAnchor="middle" className="cg-mind">{mind === id ? "🟢 no cambió" : `🧠 ${P(mind)?.name}`}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ======================= 🦜 HILOS =======================

function Threads({ d, P }: { d: RoundDetails; P: Lookup }) {
  const [reveal, setReveal] = useState(true);
  return (
    <div className="details-list">
      <button type="button" className="toggle" aria-pressed={reveal} onClick={() => { sfx.click(); setReveal(!reveal); }}>
        <span className="box" /> <span>🧠 Mostrar quién escribió cada cotorreo de verdad</span>
      </button>
      {d.threads.map((t) => (
        <div key={t.cycle} className="thread-log">
          <div className="ksub"><span className="q">❓ {t.question}</span>{d.threads.length > 1 && <span>ciclo {t.cycle}</span>}</div>
          {t.posts.map((p) => <ThreadCard key={p.id} post={p} question={t.question} P={P} reveal={reveal} />)}
        </div>
      ))}
    </div>
  );
}

function ThreadCard({ post, question, P, reveal }: { post: ThreadLogPost; question: string; P: Lookup; reveal: boolean }) {
  const [open, setOpen] = useState(false);
  const who = (body: string, mind: string) => (
    <>
      <b>{P(body)?.name}</b>
      {reveal && <span className={"mind-tag" + (mind === body ? " same" : "")}>{mind === body ? "🟢 su dueño" : `🧠 ${P(mind)?.name}`}</span>}
    </>
  );
  return (
    <div className="kbox tcard">
      <div className="tcard-main">
        <Avatar avatar={P(post.body)?.avatar} color={P(post.body)?.color ?? "#999"} size={36} />
        <div className="tcard-body">
          <div>{who(post.body, post.mind)}</div>
          <div className="ktext">{post.text}</div>
          <div className="tcard-meta">
            <span>💬 {post.replies.length}</span><span>❤️ {post.likes}</span><span>🤨 {post.sus}</span>
            {post.replies.length > 0 && <button className="kact" onClick={() => { sfx.click(); setOpen(!open); }}>{open ? "Ocultar respuestas" : "Ver respuestas"}</button>}
            <button className="kcite" onClick={async () => {
              sfx.click();
              download(await threadImage({ question, post, P, reveal }), fileName("hilo", P(post.body)?.name ?? "post"));
            }}>⬇️ Imagen</button>
          </div>
        </div>
      </div>
      {open && (
        <div className="tcard-replies">
          {post.replies.map((r) => (
            <div key={r.id} className="tcard-reply">
              <Avatar avatar={P(r.body)?.avatar} color={P(r.body)?.color ?? "#999"} size={26} />
              <div><div>{who(r.body, r.mind)} <span className="muted small">❤️ {r.likes} · 🤨 {r.sus}</span></div><div>{r.text}</div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ======================= 🗳️ VOTOS =======================

function Votes({ d, P }: { d: RoundDetails; P: Lookup }) {
  return (
    <div className="details-list">
      {d.votes.map((v, i) => (
        <div key={i} className="vote-log">
          <h3>{KIND[v.kind]}{v.kind !== "FINAL_VOTE" && ` · ciclo ${v.cycle}`}</h3>
          <ul className="cg-list">
            {v.ballots.map((b) => (
              <li key={b.voter}>
                <b>{P(b.voter)?.name}</b>
                {b.voterBody !== b.voter && <span className="muted"> (en el cuerpo de {P(b.voterBody)?.name})</span>}
                {" → "}
                {b.body === null ? <span className="muted">⏭ Omitió</span>
                  : v.kind === "UNMASK"
                    ? <>acusó: en <b>{P(b.body)?.name}</b> está <b>{b.mind === b.body ? `${P(b.body)?.name} mismo` : P(b.mind ?? "")?.name}</b></>
                    : <>votó por <b>{P(b.body)?.name}</b></>}
              </li>
            ))}
            {v.ballots.length === 0 && <li className="muted">Nadie votó.</li>}
          </ul>
        </div>
      ))}
    </div>
  );
}

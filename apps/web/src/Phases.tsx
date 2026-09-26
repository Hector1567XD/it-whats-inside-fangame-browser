import { useEffect, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import { Avatar } from "./Avatar";
import { Composer, GroupChat, RichText, handle, type Lookup, type Me, type Seed } from "./Chat";
import { sfx } from "./sfx";
import { activeCount, type ChatMsg, type PlayerView, type PostView, type ReplyView, type StateView } from "./net";

/** ❤️ y 🤨 que di yo (el server solo guarda los conteos). */
export type Social = { liked: Set<string>; sussed: Set<string>; like: (id: string) => void; sus: (id: string) => void };

/** Quién está escribiendo, en texto corto. */
function typingText(names: string[]) {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} está escribiendo…`;
  if (names.length === 2) return `${names[0]} y ${names[1]} están escribiendo…`;
  return `${names.length} personas están escribiendo…`;
}

// ======================= LA PREGUNTA (La Máquina cotorrea en Cotorra 🦜) =======================

export function QuestionPhase({ room, s, me, P, players }: { room: Room; s: StateView; me: Me; P: Lookup; players: PlayerView[] }) {
  const [t, setT] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const submitted = P(me.mindId)?.submitted;
  const body = P(me.bodyId);
  useEffect(() => { ref.current?.focus(); }, []);
  const send = () => { if (t.trim()) { sfx.boing(); room.send("answer", { text: t.trim() }); } };
  const active = players.filter((p) => !p.out);
  const done = active.filter((p) => p.submitted).length;
  const total = activeCount(players);
  const spectator = !!me.spectator;
  const machine = (
    <article className="kpost machine">
      <span className="kbot">🧳</span>
      <div className="kmain">
        <div className="khead"><b>La Máquina</b><span className="kbadge" title="Verificada (por sí misma)">✦</span><span className="khandle">@lamaquina · ahora</span></div>
        <div className="ktext">{s.question}</div>
      </div>
    </article>
  );
  const waiting = (
    <div className="kwaiting">
      {/* Anónimo a propósito: mostrar la mente de cada quien delataría a los fantasmas (nunca responden). */}
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={"w dot-anon" + (i < done ? " ok" : "")} title={i < done ? "Ya cotorreó" : "Pensando…"}>
          {i < done ? "✓" : "…"}
        </span>
      ))}
      <span>{done}/{total} cotorrearon</span>
    </div>
  );

  if (spectator) {
    return (
      <div className="kq pop-in">
        <div className="kapp">🦜 cotorra <small>· la red de la fiesta</small></div>
        <div className="kbox kcard">{machine}</div>
        <p className="muted center-text">👻 Eres espectador: los demás están respondiendo.</p>
        {waiting}
      </div>
    );
  }

  const preview: ReplyView = { id: "preview", body: me.bodyId, text: t || "…", likes: 0, sus: 0 };
  return (
    <div className="kq pop-in">
      <div className="kapp">🦜 cotorra <small>· la red de la fiesta</small></div>
      <div className="khint">
        {me.mindId === me.bodyId
          ? <>🎭 Sales como <b>{handle(body?.name)}</b> (sigues en tu cuerpo). ¿Contestas normal… o raro para que crean que cambiaste?</>
          : <>🎭 Sales como <b>{handle(body?.name)}</b>. ¿Contestas como tú… o como {body?.name}?</>}
      </div>
      <div className="kbox kcard">
        {machine}
        {submitted ? (
          <div className="kdone pop-in">✓ ¡Cotorreado! Esperando al resto…</div>
        ) : (
          <>
            <div className="kreplying">Respondiendo a <b>@lamaquina</b></div>
            <div className="kcompose">
              <Avatar avatar={body?.avatar} color={body?.color ?? "#999"} size={44} />
              <textarea ref={ref} value={t} maxLength={200} rows={3} placeholder="Cotorrea tu respuesta…"
                onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
            </div>
            <div className="kcfoot">
              <span className="muted small">Cotorreas como <b style={{ color: body?.color }}>{body?.name}</b> {handle(body?.name)}</span>
              <svg className="kring" viewBox="0 0 26 26" aria-label={`${t.length}/200`}>
                <circle cx="13" cy="13" r="10" className="track" />
                <circle cx="13" cy="13" r="10" className={"fill" + (t.length > 180 ? " hot" : "")}
                  strokeDasharray="62.8" strokeDashoffset={62.8 * (1 - t.length / 200)} transform="rotate(-90 13 13)" />
              </svg>
              <button className={"kbtn" + (t.trim() ? " wiggle" : "")} disabled={!t.trim()} onClick={send}>Cotorrear</button>
            </div>
          </>
        )}
      </div>
      {!submitted && (
        <div className={"kbox kcard kpreview" + (t ? " on" : "")}>
          <div className="kpreview-label">Así saldrá en el hilo 👇</div>
          <PostCard post={preview} P={P} people={players} />
        </div>
      )}
      {waiting}
    </div>
  );
}

// ======================= EL HILO (en Cotorra 🦜) =======================

function hash(str: string) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);

export function PostCard({ post, P, people, myId, social, big, replies, top, onReply, onCite, onLiked }: {
  post: PostView | ReplyView; P: Lookup; people: PlayerView[]; myId?: string; social?: Social; big?: boolean;
  replies?: number; top?: boolean; onReply?: () => void; onCite?: () => void; onLiked?: () => void;
}) {
  const author = P(post.body);
  const liked = !!social?.liked.has(post.id);
  const sussed = !!social?.sussed.has(post.id);
  return (
    <article className={"kpost" + (big ? " big" : "")}>
      <Avatar avatar={author?.avatar} color={author?.color ?? "#999"} size={big ? 48 : 36} />
      <div className="kmain">
        <div className="khead">
          <b>{author?.name ?? "?"}</b>
          {big && <span className="kbadge" title="Verificado por La Máquina (o eso dice)">✦</span>}
          <span className="khandle">{handle(author?.name)} · ahora</span>
          {top && <span className="ktop">⭐ Top</span>}
        </div>
        <div className="ktext"><RichText text={post.text} people={people} myId={myId} /></div>
        {social && (
          <div className="kacts">
            {onReply && <button className="kact rep" onClick={onReply}>💬 Responder</button>}
            {replies !== undefined && <span className="kact">💬 {replies}</span>}
            <button className={"kact like" + (liked ? " on" : "")} onClick={() => { if (!liked) onLiked?.(); social.like(post.id); }}>
              {liked ? "❤️" : "🤍"} {post.likes}
            </button>
            <button className={"kact sus" + (sussed ? " on" : "")} title="🤨 Esto no lo escribiría su dueño" onClick={() => social.sus(post.id)}>
              🤨 {post.sus || ""}
            </button>
            {big && <span className="kact">👀 {compact(120 + (hash(post.id + post.text) % 900))}</span>}
            {onCite && <button className="kcite" onClick={onCite}>↩ Citar</button>}
          </div>
        )}
      </div>
    </article>
  );
}

/** Corazones que salen volando al dar ❤️ al cotorreo principal. */
function useHearts() {
  const [hearts, setHearts] = useState<{ id: number; dx: number; e: string; d: number }[]>([]);
  const burst = () => {
    const now = Date.now();
    const add = Array.from({ length: 6 }, (_, i) => ({ id: now + i, dx: Math.random() * 120 - 60, e: ["❤️", "💖", "💗"][i % 3], d: i * 0.06 }));
    setHearts((h) => [...h, ...add]);
    setTimeout(() => setHearts((h) => h.filter((x) => !add.includes(x))), 1400);
  };
  const node = (
    <div className="khearts" aria-hidden>
      {hearts.map((h) => <span key={h.id} style={{ ["--dx" as string]: `${h.dx}px`, animationDelay: `${h.d}s` }}>{h.e}</span>)}
    </div>
  );
  return { burst, node };
}

export function ThreadPhase({ room, s, me, P, players, social, typing }: {
  room: Room; s: StateView; me: Me; P: Lookup; players: PlayerView[]; social: Social; typing: Set<string>;
}) {
  const post = s.posts[s.thread];
  const listRef = useRef<HTMLDivElement>(null);
  const [seed, setSeed] = useState<Seed>({ text: "", n: 0 });
  const hearts = useHearts();
  useEffect(() => { sfx.whoosh(); }, [s.thread]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [post?.replies.length]);
  if (!post) return null;
  const author = P(post.body);
  const spectator = !!me.spectator;
  const people = players.filter((p) => !p.bodyOut);
  const elapsed = s.settings.threadSeconds > 0 ? 100 - (s.timer / s.settings.threadSeconds) * 100 : 0;
  const best = post.replies.reduce<ReplyView | null>((b, r) => (r.likes > (b?.likes ?? 0) ? r : b), null);
  const topId = best && best.likes >= 2 && post.replies.filter((r) => r.likes === best.likes).length === 1 ? best.id : "";
  const typers = [...typing].filter((b) => b !== me.bodyId).map((b) => P(b)?.name ?? "?");
  const readOnly = spectator ? undefined : social;

  return (
    <div className="thread-wrap">
      <div className="kbox thread">
        <div className="kseg">
          {s.posts.map((p, i) => (
            <span key={p.id} className={i < s.thread ? "done" : i === s.thread ? "on" : ""}>
              {i === s.thread && <i style={{ width: `${elapsed}%` }} />}
            </span>
          ))}
        </div>
        <div className="ksub"><span className="q">🦜 {s.question}</span><span>{s.thread + 1}/{s.posts.length}</span></div>
        <div key={post.id} className="kmainpost pop-in">
          <PostCard post={post} P={P} people={people} myId={me.bodyId} big replies={post.replies.length} social={readOnly}
            onLiked={hearts.burst} />
          {hearts.node}
        </div>
        <div className="kreplies" ref={listRef}>
          {post.replies.length === 0 && <div className="muted center-text small">Sé el primero en cotorrear 👇</div>}
          {post.replies.map((r) => (
            <div key={r.id} className={"kreply pop-in" + (r.body === me.bodyId ? " mine" : "") + (r.id === topId ? " top" : "")}>
              <PostCard post={r} P={P} people={people} myId={me.bodyId} social={readOnly} top={r.id === topId}
                onReply={spectator || r.body === me.bodyId ? undefined : () => setSeed((x) => ({ text: handle(P(r.body)?.name) + " ", n: x.n + 1 }))} />
            </div>
          ))}
        </div>
        <div className={"ktypers" + (typers.length ? " on" : "")}>
          <span className="kdots"><i /><i /><i /></span> {typingText(typers)}
        </div>
        {spectator ? <div className="read-only">👻 Eres espectador: solo puedes leer.</div> : (
          <>
            <div className="ktarget">Cotorreando en el hilo de <b>{handle(author?.name)}</b> como <b style={{ color: P(me.bodyId)?.color }}>{P(me.bodyId)?.name}</b> · <b>@</b> para etiquetar</div>
            <Composer className="kcomposer" focusKey={post.id} maxLength={200} button="Cotorrear" buttonClass="kbtn" seed={seed}
              before={<Avatar avatar={P(me.bodyId)?.avatar} color={P(me.bodyId)?.color ?? "#999"} size={32} />}
              mentions={people.filter((p) => p.id !== me.bodyId)} onTyping={() => room.send("typing", {})}
              onSend={(text) => { sfx.send(); room.send("reply", { text }); }}
              placeholder="Cotorrea tu respuesta" />
          </>
        )}
      </div>
    </div>
  );
}

// ======================= CHAT GLOBAL (con Cotorra al lado) =======================

export function DayView({ room, s, chat, me, P, players, social, typing }: {
  room: Room; s: StateView; chat: ChatMsg[]; me: Me; P: Lookup; players: PlayerView[]; social: Social; typing: Set<string>;
}) {
  const [quote, setQuote] = useState<PostView | null>(null);
  const speakAs = P(me.bodyId)?.name ?? "";
  const spectator = !!me.spectator;
  const people = players.filter((p) => !p.bodyOut);
  const chatEl = (
    <GroupChat room={room} entries={chat} me={me} P={P} people={people} speakAs={speakAs} readOnly={spectator}
      heads={people} typing={typing} quote={quote} onClearQuote={() => setQuote(null)} />
  );
  if (s.posts.length === 0) return chatEl;
  const sorted = [...s.posts].sort((a, b) => b.likes - a.likes);
  const mostReplies = Math.max(...s.posts.map((p) => p.replies.length));
  return (
    <div className="split day">
      {chatEl}
      <aside className="kbox answers">
        <div className="kside-title">🦜 Cotorra {!spectator && <small>· toca ↩ para citar</small>}</div>
        <div className="ksub"><span className="q">❓ {s.question}</span></div>
        <div className="answers-list">
          {sorted.map((p) => (
            <div key={p.id} className="kmini">
              {mostReplies > 0 && p.replies.length === mostReplies && <span className="khot">🔥 más cotorreado</span>}
              <PostCard post={p} P={P} people={people} myId={me.bodyId} replies={p.replies.length} social={spectator ? undefined : social}
                onCite={spectator ? undefined : () => { sfx.pop(); setQuote(p); }} />
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

// ======================= ADIVINANZA =======================

export function Guess({ room, s, players, me, P }: { room: Room; s: StateView; players: PlayerView[]; me: Me; P: Lookup }) {
  const classic = s.settings.mode === "classic";
  const bodies = players.filter((p) => p.id !== me.bodyId && !p.bodyOut);
  const outBodies = players.filter((p) => p.bodyOut);
  // En clásico, por defecto nadie cambió; solo marcas a los que crees que cambiaron.
  const [g, setG] = useState<Record<string, string>>(() =>
    classic ? Object.fromEntries(bodies.filter((b) => b.id !== me.mindId && !b.out).map((b) => [b.id, b.id])) : {},
  );
  const submitted = P(me.mindId)?.submitted;
  const active = players.filter((p) => !p.out);
  const done = active.filter((p) => p.submitted).length;
  const used = new Set(Object.values(g).filter(Boolean));
  if (me.spectator) {
    return <div className="card guess center-text"><h2>🧩 ¿Quién es quién?</h2><p className="muted">👻 Eres espectador. Los demás están adivinando ({done}/{activeCount(players)})…</p></div>;
  }
  const filled = bodies.filter((b) => g[b.id]).length;

  function pick(body: string, mind: string) {
    if (submitted) return;
    sfx.pop();
    setG((prev) => ({ ...prev, [body]: prev[body] === mind ? "" : mind }));
  }

  return (
    <div className="card guess">
      <h2>🧩 ¿Quién es quién?</h2>
      {outBodies.length > 0 && (
        <p className="muted small">🎭 Ya desenmascarados (fuera de la adivinanza): {outBodies.map((b) => b.name).join(", ")}.</p>
      )}
      <p className="muted">
        {classic
          ? <>Algunos cambiaron y otros no. Marca <b>🙋 No cambió</b> o la mente que crees que está adentro.</>
          : <>Todos cambiaron. Elige qué mente hay en cada cuerpo.</>}
        {" "}+200 por descubrir un cambio{classic && " · +50 por acertar que alguien no cambió"}.
        {" "}Tú estás en el cuerpo de <b>{P(me.bodyId)?.name}</b>.
      </p>
      <div className="grid">
        {bodies.map((b, i) => {
          const val = g[b.id];
          const m = val ? P(val) : undefined;
          // Si yo cambié, sé que mi cuerpo original NO tiene a su dueño (yo estoy aquí).
          const canBeSame = classic && b.id !== me.mindId && !b.out;
          const minds = players.filter((p) => p.id !== me.mindId && p.id !== b.id && !p.out);
          return (
            <div key={b.id} className={"gcard pop-in" + (val ? (val === b.id ? " same" : " filled") : "")} style={{ animationDelay: `${i * 0.05}s` }}>
              <div className="gbody">
                <Avatar avatar={b.avatar} color={b.color} size={64} />
                <div className="gname">Cuerpo de {b.name}</div>
              </div>
              <div className="gmind">
                {!val ? "🧠 ¿…?" : val === b.id ? "🙋 No cambió" : <>🧠 <b>{m?.name}</b></>}
              </div>
              <div className="mind-chips">
                {canBeSame && (
                  <button disabled={submitted} className={"mchip same" + (val === b.id ? " on" : "")} onClick={() => pick(b.id, b.id)}>
                    🙋 No cambió
                  </button>
                )}
                {minds.map((mm) => (
                  <button key={mm.id} disabled={submitted}
                    className={"mchip" + (val === mm.id ? " on" : "") + (used.has(mm.id) && val !== mm.id ? " used" : "")}
                    onClick={() => pick(b.id, mm.id)}>
                    {mm.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {submitted ? <p className="muted center-text">✅ Enviado. Esperando al resto ({done}/{activeCount(players)})…</p> : (
        <button className={"btn big" + (filled === bodies.length ? " wiggle" : "")} onClick={() => { sfx.boing(); room.send("guesses", { guesses: g }); }}>
          ENVIAR {filled === bodies.length ? "🚀" : `(${filled}/${bodies.length})`}
        </button>
      )}
    </div>
  );
}

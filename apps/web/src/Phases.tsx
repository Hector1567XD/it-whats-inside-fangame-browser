import { useEffect, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import { Avatar } from "./Avatar";
import { Composer, GroupChat, type Lookup, type Me } from "./Chat";
import { sfx } from "./sfx";
import type { ChatMsg, PlayerView, PostView, ReplyView, StateView } from "./net";

// ======================= LA PREGUNTA =======================

export function QuestionPhase({ room, s, me, P, players }: { room: Room; s: StateView; me: Me; P: Lookup; players: PlayerView[] }) {
  const [t, setT] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const submitted = P(me.mindId)?.submitted;
  const done = players.filter((p) => p.submitted && !p.out).length;
  const body = P(me.bodyId);
  useEffect(() => { ref.current?.focus(); }, []);
  const send = () => { if (t.trim()) { sfx.boing(); room.send("answer", { text: t.trim() }); } };
  const active = players.filter((p) => !p.out);
  if (P(me.mindId)?.out) {
    return (
      <div className="card question pop-in">
        <div className="q-label">❓ LA PREGUNTA</div>
        <h1 className="q-text">{s.question}</h1>
        <p className="muted">👻 Eres espectador: los demás están respondiendo ({active.filter((p) => p.submitted).length}/{active.length}).</p>
      </div>
    );
  }

  return (
    <div className="card question pop-in">
      <div className="q-label">❓ LA PREGUNTA</div>
      <h1 className="q-text">{s.question}</h1>
      <p className="muted">
        {me.mindId === me.bodyId
          ? <>Tu respuesta saldrá como <b>{body?.name}</b> (sigues en tu cuerpo). ¿Contestas normal… o raro para que crean que cambiaste? 🎭</>
          : <>Tu respuesta saldrá publicada como si fuera de <b>{body?.name}</b>. ¿Respondes como tú… o como respondería {body?.name}? 😏</>}
      </p>
      {submitted ? (
        <div className="q-done pop-in">✅ ¡Respuesta enviada! Esperando al resto ({done}/{active.length})…</div>
      ) : (
        <>
          <div className="q-compose">
            <Avatar avatar={body?.avatar} color={body?.color ?? "#999"} size={48} />
            <textarea ref={ref} value={t} maxLength={200} rows={3} placeholder={`Responde como ${body?.name}…`}
              onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
          </div>
          <div className="q-foot">
            <span className="muted small">{t.length}/200 · {done}/{active.length} ya respondieron</span>
            <button className={"btn" + (t.trim() ? " wiggle" : "")} disabled={!t.trim()} onClick={send}>Publicar 🚀</button>
          </div>
        </>
      )}
    </div>
  );
}

// ======================= EL HILO (estilo X) =======================

const handle = (name = "") => "@" + name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
function hash(str: string) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);

export function PostCard({ post, P, liked, onLike, big, replies, time = "ahora" }: {
  post: PostView | ReplyView; P: Lookup; liked: boolean; onLike?: () => void; big?: boolean; replies?: number; time?: string;
}) {
  const author = P(post.body);
  const h = hash(post.id + post.text);
  return (
    <article className={"xpost" + (big ? " big" : "")}>
      <Avatar avatar={author?.avatar} color={author?.color ?? "#999"} size={big ? 52 : 38} />
      <div className="xmain">
        <div className="xhead">
          <b>{author?.name ?? "?"}</b>
          {big && <span className="xverified" title="Cuenta verificada (o eso dice)">✔</span>}
          <span className="xhandle">{handle(author?.name)} · {time}</span>
        </div>
        <div className="xtext">{post.text}</div>
        <div className="xactions">
          {replies !== undefined && <span>💬 {replies}</span>}
          {big && <span>🔁 {h % 97}</span>}
          <button className={"xlike" + (liked ? " on" : "")} disabled={!onLike} onClick={onLike}>
            {liked ? "❤️" : "🤍"} {post.likes}
          </button>
          {big && <span>📊 {compact(120 + (h % 9000))}</span>}
        </div>
      </div>
    </article>
  );
}

export function ThreadPhase({ room, s, me, P, liked, toggleLike }: {
  room: Room; s: StateView; me: Me; P: Lookup; liked: Set<string>; toggleLike: (id: string) => void;
}) {
  const post = s.posts[s.thread];
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { sfx.whoosh(); }, [s.thread]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [post?.replies.length]);
  if (!post) return null;
  const author = P(post.body);
  const spectator = !!P(me.mindId)?.out;
  const likeFn = (id: string) => (spectator ? undefined : () => toggleLike(id));
  const pct = s.settings.threadSeconds > 0 ? (s.timer / s.settings.threadSeconds) * 100 : 0;

  return (
    <div className="thread-wrap">
      <div className="card thread">
        <div className="thread-q">❓ {s.question}</div>
        <div className="thread-progress">
          {s.posts.map((p, i) => <span key={p.id} className={i < s.thread ? "done" : i === s.thread ? "on" : ""} />)}
          <b>Respuesta {s.thread + 1} de {s.posts.length}</b>
        </div>
        <div className="thread-bar"><div style={{ width: `${pct}%` }} /></div>
        <div key={post.id} className="thread-post pop-in">
          <PostCard post={post} P={P} big replies={post.replies.length} liked={liked.has(post.id)} onLike={likeFn(post.id)} />
        </div>
        <div className="xreplies" ref={listRef}>
          {post.replies.length === 0 && <div className="muted center-text small">Sé el primero en responder 👇</div>}
          {post.replies.map((r) => (
            <div key={r.id} className={"xreply pop-in" + (r.body === me.bodyId ? " mine" : "")}>
              <PostCard post={r} P={P} liked={liked.has(r.id)} onLike={likeFn(r.id)} />
            </div>
          ))}
        </div>
        {spectator ? <div className="read-only">👻 Eres espectador: solo puedes leer.</div> : <Composer focusKey={post.id} maxLength={200} button="Responder"
          onSend={(text) => { sfx.send(); room.send("reply", { text }); }}
          placeholder={`Responder a ${handle(author?.name)} como ${P(me.bodyId)?.name}…`} />}
      </div>
    </div>
  );
}

// ======================= CHAT GLOBAL (con las respuestas al lado) =======================

export function DayView({ room, s, chat, me, P, liked, toggleLike }: {
  room: Room; s: StateView; chat: ChatMsg[]; me: Me; P: Lookup; liked: Set<string>; toggleLike: (id: string) => void;
}) {
  const speakAs = P(me.bodyId)?.name ?? "";
  const spectator = !!P(me.mindId)?.out;
  if (s.posts.length === 0) return <GroupChat room={room} entries={chat} me={me} P={P} speakAs={speakAs} readOnly={spectator} />;
  return (
    <div className="split day">
      <GroupChat room={room} entries={chat} me={me} P={P} speakAs={speakAs} readOnly={spectator} />
      <aside className="card answers">
        <div className="thread-q">❓ {s.question}</div>
        <div className="answers-list">
          {s.posts.map((p) => (
            <PostCard key={p.id} post={p} P={P} replies={p.replies.length} liked={liked.has(p.id)} onLike={spectator ? undefined : () => toggleLike(p.id)} />
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
  if (P(me.mindId)?.out) {
    return <div className="card guess center-text"><h2>🧩 ¿Quién es quién?</h2><p className="muted">👻 Eres espectador. Los demás están adivinando ({done}/{active.length})…</p></div>;
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
      {submitted ? <p className="muted center-text">✅ Enviado. Esperando al resto ({done}/{active.length})…</p> : (
        <button className={"btn big" + (filled === bodies.length ? " wiggle" : "")} onClick={() => { sfx.boing(); room.send("guesses", { guesses: g }); }}>
          ENVIAR {filled === bodies.length ? "🚀" : `(${filled}/${bodies.length})`}
        </button>
      )}
    </div>
  );
}

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { Room } from "colyseus.js";
import { Avatar } from "./Avatar";
import { sfx } from "./sfx";
import type { ChatEdge, ChatMsg, DmMsg, PlayerView, PostView, Quote, StateView } from "./net";
import { ChatGraph } from "./ChatGraph";

export type Me = { mindId: string; bodyId: string; spectator?: boolean }; // spectator: privado, lo manda el server
export type Lookup = (id: string) => PlayerView | undefined;

// ======================= @menciones =======================

export const slug = (name = "") => name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
export const handle = (name = "") => "@" + slug(name);

/** Texto con las @menciones a cuerpos resaltadas. La que te nombra a ti va en sólido. */
export function RichText({ text, people, myId }: { text: string; people: PlayerView[]; myId?: string }) {
  const parts = text.split(/(@[\p{L}\p{N}_]+)/u);
  return (
    <>
      {parts.map((part, i) => {
        const p = part.startsWith("@") ? people.find((x) => slug(x.name) === slug(part.slice(1))) : undefined;
        return p
          ? <span key={i} className={"mention" + (p.id === myId ? " me" : "")}>@{p.name}</span>
          : <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

export type Seed = { text: string; n: number };

/**
 * Caja de texto. Cada vez que cambia `focusKey` (p. ej. al abrir otro chat) se enfoca sola.
 * Con `mentions`, escribir "@" abre la lista de cuerpos para etiquetar. `seed` le mete texto desde fuera.
 */
export function Composer({
  onSend, placeholder, disabled, focusKey = "", maxLength = 300, button = "Enviar", buttonClass = "btn",
  className = "", before, mentions, onTyping, seed,
}: {
  onSend: (t: string) => void; placeholder: string; disabled?: boolean; focusKey?: string; maxLength?: number;
  button?: ReactNode; buttonClass?: string; className?: string; before?: ReactNode;
  mentions?: PlayerView[]; onTyping?: () => void; seed?: Seed;
}) {
  const [t, setT] = useState("");
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [closed, setClosed] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => { if (!disabled) ref.current?.focus({ preventScroll: true }); }, [focusKey, disabled]);
  useEffect(() => {
    if (!seed) return;
    setT(seed.text);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(seed.text.length, seed.text.length);
      setCaret(seed.text.length);
    });
  }, [seed?.n]);

  const query = mentions && !closed ? t.slice(0, caret).match(/@([\p{L}\p{N}_]*)$/u)?.[1] : undefined;
  const options = query === undefined ? [] : mentions!.filter((p) => slug(p.name).startsWith(slug(query))).slice(0, 6);
  const open = options.length > 0;
  const cur = Math.min(sel, options.length - 1);

  function pick(p: PlayerView) {
    const before = t.slice(0, caret).replace(/@([\p{L}\p{N}_]*)$/u, handle(p.name) + " ");
    const next = before + t.slice(caret);
    setT(next.slice(0, maxLength));
    setSel(0);
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(before.length, before.length); setCaret(before.length); });
  }
  const send = () => { if (t.trim()) { onSend(t.trim()); setT(""); setCaret(0); } };

  return (
    <div className={"composer " + className}>
      {before}
      <div className="cmp-wrap">
        <input ref={ref} value={t} maxLength={maxLength} disabled={disabled} placeholder={placeholder}
          onChange={(e) => {
            setT(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setClosed(false); setSel(0);
            const now = Date.now();
            if (onTyping && e.target.value && now - lastTyping.current > 1200) { lastTyping.current = now; onTyping(); }
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onBlur={() => { blurTimer.current = setTimeout(() => setClosed(true), 120); }}
          onFocus={() => { clearTimeout(blurTimer.current); setClosed(false); }}
          onKeyDown={(e) => {
            if (open) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setSel((cur + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(options[cur]); return; }
              if (e.key === "Escape") { setClosed(true); return; }
            }
            if (e.key === "Enter") send();
          }} />
        {open && (
          <div className="at-pop">
            <div className="at-hint">Etiquetar</div>
            {options.map((p, i) => (
              <button key={p.id} type="button" className={i === cur ? "on" : ""}
                onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
                <Avatar avatar={p.avatar} color={p.color} size={24} /> {p.name} <small>{handle(p.name)}</small>
              </button>
            ))}
          </div>
        )}
      </div>
      <button className={buttonClass} disabled={disabled} onClick={send}>{button}</button>
    </div>
  );
}

// ======================= chat grupal =======================

type Item = { fromBody: string; text: string; ts: number; mine: boolean; tag?: string; quote?: Quote };

/** Un cotorreo citado dentro de un mensaje. */
export function QuoteBox({ q, P }: { q: Quote; P: Lookup }) {
  return (
    <span className="quote-box">
      <span className="quote-logo">🦜</span><b>{handle(P(q.body)?.name)}</b> {q.text.length > 60 ? q.text.slice(0, 60) + "…" : q.text}
    </span>
  );
}

/** Mensajes planos; los seguidos de la misma persona se agrupan (un solo avatar y nombre). */
export function Messages({ items, P, people, myId, empty = "Nadie ha dicho nada aún… 🦗" }: {
  items: Item[]; P: Lookup; people: PlayerView[]; myId?: string; empty?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" }); }, [items.length]);
  return (
    <div className="msgs" ref={ref}>
      {items.length === 0 && <div className="muted center-text">{empty}</div>}
      {items.map((m, i) => {
        const prev = items[i - 1];
        const newTag = !!m.tag && m.tag !== prev?.tag;
        const first = !prev || newTag || prev.fromBody !== m.fromBody;
        const who = P(m.fromBody);
        return (
          <Fragment key={m.ts + "-" + i}>
            {newTag && <div className="sys">{m.tag}</div>}
            <div className={"msg" + (m.mine ? " mine" : "") + (first ? " first" : "")}>
              {!m.mine && (first ? <Avatar avatar={who?.avatar} color={who?.color ?? "#999"} size={30} /> : <span className="av-gap" />)}
              <div className="bubble">
                {first && !m.mine && <div className="who" style={{ color: who?.color }}>{who?.name ?? "?"}</div>}
                {m.quote && <QuoteBox q={m.quote} P={P} />}
                <RichText text={m.text} people={people} myId={myId} />
              </div>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

export function GroupChat({ room, entries, me, P, people, speakAs, className = "", readOnly, heads, typing, quote, onClearQuote }: {
  room: Room; entries: ChatMsg[]; me: Me; P: Lookup; people: PlayerView[]; speakAs: string; className?: string; readOnly?: boolean;
  heads?: PlayerView[]; typing?: Set<string>; quote?: PostView | null; onClearQuote?: () => void;
}) {
  const myId = entries.some((m) => m.real) ? me.mindId : me.bodyId;
  return (
    <div className={"card chat " + className}>
      {heads && (
        <div className="chat-heads">
          {heads.map((p) => (
            <span key={p.id} className={"head" + (typing?.has(p.id) ? " typing" : "")} title={p.name}>
              <Avatar avatar={p.avatar} color={p.color} size={24} />
            </span>
          ))}
        </div>
      )}
      <Messages items={entries.map((m) => ({ ...m, mine: m.fromBody === (m.real ? me.mindId : me.bodyId) }))} P={P} people={people} myId={myId} />
      {readOnly ? <div className="read-only">👻 Eres espectador: solo puedes leer.</div> : (
        <>
          {quote && (
            <div className="quote-chip pop-in">
              <span>↩ Citando a <b>{handle(P(quote.body)?.name)}</b>: {quote.text.length > 50 ? quote.text.slice(0, 50) + "…" : quote.text}</span>
              <button onClick={onClearQuote} title="Quitar cita">✕</button>
            </div>
          )}
          <Composer focusKey={quote?.id} mentions={people.filter((p) => p.id !== myId)}
            onTyping={heads ? () => room.send("typing", {}) : undefined}
            onSend={(text) => { room.send("chat", { text, quote: quote?.id }); onClearQuote?.(); }}
            placeholder={`Escribe como ${speakAs}… (@ para etiquetar)`} />
        </>
      )}
    </div>
  );
}

// ======================= chat privado =======================

const ago = (ts: number) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  return s < 45 ? "ahora" : `${Math.round(s / 60)}m`;
};

export function Night({ room, s, players, me, dms, used, P, typing, seen, graph }: {
  room: Room; s: StateView; players: PlayerView[]; me: Me; dms: Record<string, DmMsg[]>; used: number; P: Lookup;
  typing: Set<string>; seen: Record<string, number>; graph: ChatEdge[];
}) {
  const others = players.filter((p) => p.id !== me.bodyId && !p.bodyOut);
  // Solo se abre el chat que tocas: así un mensaje nuevo brilla en la bandeja y el "Visto" es real.
  const [active, setSel] = useState<string>("");
  const convo = dms[active] ?? [];
  // Mensajes leídos por conversación: el chat abierto se marca como leído al instante.
  const [read, setRead] = useState<Record<string, number>>({});
  useEffect(() => { if (active) setRead((v) => ({ ...v, [active]: convo.length })); }, [active, convo.length]);
  // "Visto": aviso hasta qué mensaje suyo leí.
  const lastTheirs = [...convo].reverse().find((m) => m.fromBody !== me.bodyId)?.ts;
  useEffect(() => { if (active && lastTheirs) room.send("seen", { withBody: active, ts: lastTheirs }); }, [active, lastTheirs]);

  const unread = (id: string) =>
    id === active ? 0 : (dms[id] ?? []).slice(read[id] ?? 0).filter((m) => m.fromBody !== me.bodyId).length;
  const left = Math.max(0, s.chatLimit - used);
  const hasConvo = (id: string) => (dms[id]?.length ?? 0) > 0;
  const locked = (id: string) => !hasConvo(id) && left === 0;
  // Te escribió y todavía no contestas: su fila brilla.
  const waiting = (id: string) => { const l = dms[id]?.at(-1); return !!l && l.fromBody !== me.bodyId && id !== active; };
  const body = P(me.bodyId);

  if (me.spectator) return <ChatGraph players={players} edges={graph} />;

  const myLast = convo.at(-1)?.fromBody === me.bodyId ? convo.at(-1) : undefined;
  const who = P(active);
  return (
    <div className="night">
      <div className="card inbox">
        <div className={"quota" + (left === 0 ? " empty" : "")}>
          <div className="quota-title">💬 Chats para iniciar</div>
          <div className="quota-dots">
            {Array.from({ length: s.chatLimit }, (_, i) => <span key={i} className={i < left ? "on" : ""} style={{ animationDelay: `${i * 0.2}s` }}>💬</span>)}
          </div>
          <b>{left}/{s.chatLimit} disponibles</b>
          <p className="small">Responder a quien te escriba es gratis.</p>
        </div>
        <div className="inbox-title">Mensajes <small>como {body?.name}</small></div>
        {others.map((p) => {
          const last = dms[p.id]?.at(-1);
          const preview = typing.has(p.id) ? "escribiendo…"
            : last ? (last.fromBody === me.bodyId ? "Tú: " : "") + last.text
            : locked(p.id) ? "🔒 Ya no te quedan chats" : "Toca para escribir · usa 1 💬";
          return (
            <button key={p.id} className={"row" + (active === p.id ? " on" : "") + (locked(p.id) ? " locked" : "") + (waiting(p.id) ? " incoming" : "")}
              onClick={() => { sfx.click(); setSel(p.id); }}>
              <Avatar avatar={p.avatar} color={p.color} size={36} />
              <span className="row-meta">
                <span className="row-name">{p.name}{last && <small>{ago(last.ts)}</small>}</span>
                <span className={"row-pv" + (unread(p.id) ? " unread" : "") + (typing.has(p.id) ? " typing" : "")}>
                  {waiting(p.id) && "📩 "}{preview}
                </span>
              </span>
              {unread(p.id) > 0 && <span className="dot">{unread(p.id)}</span>}
            </button>
          );
        })}
      </div>
      <div className="card dm">
        {active && who ? (
          <>
            <div className="dm-head">
              <Avatar avatar={who.avatar} color={who.color} size={38} />
              <div><b>Cuerpo de {who.name}</b><span>🌙 solo ustedes dos · {handle(who.name)}</span></div>
              <span className="dm-moon">🌙</span>
            </div>
            <DmMessages items={convo} myBody={me.bodyId}
              empty={locked(active) ? "🔒 Ya usaste todos tus chats de esta noche." : `Escribir aquí usa 1 de tus ${left} chat${left === 1 ? "" : "s"} disponibles.`}
              footer={<>
                {myLast && seen[active] >= myLast.ts && <div className="dm-seen">Visto ✓✓</div>}
                {typing.has(active) && <div className="dm-typing"><i /><i /><i /></div>}
              </>} />
            <Composer className="pill" focusKey={active} disabled={locked(active)} button="➤" buttonClass="send"
              before={<Avatar avatar={body?.avatar} color={body?.color ?? "#999"} size={28} />}
              onTyping={hasConvo(active) ? () => room.send("typing", { toBody: active }) : undefined}
              onSend={(text) => room.send("dm", { toBody: active, text })}
              placeholder={locked(active) ? "Sin chats disponibles 🔒" : `Escribe como ${body?.name}…`} />
          </>
        ) : <div className="muted center-text night-empty">🌙<br />Elige un cuerpo para hablar en privado… o quédate callado 🤫</div>}
      </div>
    </div>
  );
}

/** Globos de la noche: sin avatares (es 1 a 1) y agrupados. */
function DmMessages({ items, myBody, empty, footer }: { items: DmMsg[]; myBody: string; empty: string; footer: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" }); }, [items.length, footer]);
  return (
    <div className="dm-msgs" ref={ref}>
      {items.length === 0 && <div className="muted center-text">{empty}</div>}
      {items.map((m, i) => {
        const mine = m.fromBody === myBody;
        const first = i === 0 || items[i - 1].fromBody !== m.fromBody;
        return <div key={m.ts + "-" + i} className={"dmb" + (mine ? " mine" : "") + (first ? " first" : "")}>{m.text}</div>;
      })}
      {footer}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import { Avatar } from "./Avatar";
import { sfx } from "./sfx";
import type { ChatMsg, DmMsg, PlayerView, StateView } from "./net";

export type Me = { mindId: string; bodyId: string };
export type Lookup = (id: string) => PlayerView | undefined;

export function GroupChat({ room, entries, me, P, speakAs, className = "" }: {
  room: Room; entries: ChatMsg[]; me: Me; P: Lookup; speakAs: string; className?: string;
}) {
  return (
    <div className={"card chat " + className}>
      <Messages items={entries.map((m) => ({ ...m, mine: m.fromBody === (m.real ? me.mindId : me.bodyId) }))} P={P} />
      <Composer onSend={(text) => room.send("chat", { text })} placeholder={`Escribe como ${speakAs}…`} />
    </div>
  );
}

type Item = { fromBody: string; text: string; ts: number; mine: boolean; tag?: string };

export function Messages({ items, P, empty = "Nadie ha dicho nada aún… 🦗" }: { items: Item[]; P: Lookup; empty?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" }); }, [items.length]);
  return (
    <div className="msgs" ref={ref}>
      {items.length === 0 && <div className="muted center-text">{empty}</div>}
      {items.map((m, i) => (
        <div key={m.ts + "-" + i} className="msg-wrap">
          {m.tag && m.tag !== items[i - 1]?.tag && <div className="sys">{m.tag}</div>}
          <div className={"msg" + (m.mine ? " mine" : "")}>
            <Avatar avatar={P(m.fromBody)?.avatar} color={P(m.fromBody)?.color ?? "#999"} size={34} />
            <div className="bubble">
              <div className="who" style={{ color: P(m.fromBody)?.color }}>{P(m.fromBody)?.name ?? "?"}</div>
              {m.text}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Caja de texto. Cada vez que cambia `focusKey` (p. ej. al abrir otro chat) se enfoca sola. */
export function Composer({ onSend, placeholder, disabled, focusKey = "", maxLength = 300, button = "Enviar" }: {
  onSend: (t: string) => void; placeholder: string; disabled?: boolean; focusKey?: string; maxLength?: number; button?: string;
}) {
  const [t, setT] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!disabled) ref.current?.focus({ preventScroll: true }); }, [focusKey, disabled]);
  const send = () => { if (t.trim()) { onSend(t.trim()); setT(""); } };
  return (
    <div className="composer">
      <input ref={ref} value={t} maxLength={maxLength} disabled={disabled} placeholder={placeholder}
        onChange={(e) => setT(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
      <button className="btn" disabled={disabled} onClick={send}>{button}</button>
    </div>
  );
}

export function Night({ room, s, players, me, dms, used, P }: {
  room: Room; s: StateView; players: PlayerView[]; me: Me; dms: Record<string, DmMsg[]>; used: number; P: Lookup;
}) {
  const others = players.filter((p) => p.id !== me.bodyId);
  const [sel, setSel] = useState<string>("");
  const active = sel || Object.keys(dms)[0] || "";
  // Mensajes leídos por conversación: el chat abierto se marca como leído al instante.
  const [seen, setSeen] = useState<Record<string, number>>({});
  const activeLen = dms[active]?.length ?? 0;
  useEffect(() => { if (active) setSeen((v) => ({ ...v, [active]: activeLen })); }, [active, activeLen]);
  const unread = (id: string) =>
    id === active ? 0 : (dms[id] ?? []).slice(seen[id] ?? 0).filter((m) => m.fromBody !== me.bodyId).length;
  const left = Math.max(0, s.chatLimit - used);
  const hasConvo = (id: string) => (dms[id]?.length ?? 0) > 0;
  const iStarted = (id: string) => dms[id]?.[0]?.fromBody === me.bodyId;
  const locked = (id: string) => !hasConvo(id) && left === 0;

  return (
    <div className="night">
      <div className="card tabs">
        <div className={"quota" + (left === 0 ? " empty" : "")}>
          <div className="quota-title">💬 Chats para iniciar</div>
          <div className="quota-dots">
            {Array.from({ length: s.chatLimit }, (_, i) => <span key={i} className={i < left ? "on" : ""}>💬</span>)}
          </div>
          <b>{left}/{s.chatLimit} disponibles</b>
          <p className="small">Responder a quien te escriba es gratis.</p>
        </div>
        <p className="muted small">Estás en el cuerpo de <b>{P(me.bodyId)?.name}</b>.</p>
        {others.map((p) => (
          <button key={p.id} className={"tab" + (active === p.id ? " on" : "") + (locked(p.id) ? " locked" : "")}
            onClick={() => { sfx.click(); setSel(p.id); }}>
            <Avatar avatar={p.avatar} color={p.color} size={32} /> {p.name}
            <span className="tab-state">
              {hasConvo(p.id) ? (iStarted(p.id) ? "abierto" : "📩 te escribió") : locked(p.id) ? "🔒" : "nuevo"}
            </span>
            {unread(p.id) > 0 && <span className="dot">{unread(p.id)}</span>}
          </button>
        ))}
      </div>
      <div className="card chat">
        {active ? (
          <>
            <div className="chat-head">🌙 Privado con el cuerpo de <b>{P(active)?.name}</b></div>
            <Messages items={(dms[active] ?? []).map((m) => ({ ...m, mine: m.fromBody === me.bodyId }))} P={P}
              empty={locked(active) ? "🔒 Ya usaste todos tus chats de esta noche." : `Escribir aquí usa 1 de tus ${left} chat${left === 1 ? "" : "s"} disponibles.`} />
            <Composer focusKey={active} disabled={locked(active)} onSend={(text) => room.send("dm", { toBody: active, text })}
              placeholder={locked(active) ? "Sin chats disponibles 🔒" : `Escribe como ${P(me.bodyId)?.name}…`} />
          </>
        ) : <div className="muted center-text night-empty">🌙<br />Elige un cuerpo para hablar en privado… o quédate callado 🤫</div>}
      </div>
    </div>
  );
}

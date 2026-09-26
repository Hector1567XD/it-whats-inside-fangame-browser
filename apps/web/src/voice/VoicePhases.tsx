import { useEffect, useRef } from "react";
import type { Room } from "colyseus.js";
import type { CallState, ChatEdge, PlayerView, StateView } from "../net";
import type { Lookup, Me } from "../Chat";
import { Avatar } from "../Avatar";
import { ChatGraph } from "../ChatGraph";
import { sfx } from "../sfx";
import { VoiceBar } from "./VoiceBar";
import type { Voice } from "./useVoice";

/** ☀️ Chat global por voz: los cuerpos activos, con el anillo de quién habla. Reemplaza al chat de texto. */
export function VoiceRoom({ v, people, me, P }: { v: Voice; people: PlayerView[]; me: Me; P: Lookup }) {
  const body = P(me.bodyId);
  return (
    <div className="card voice-room">
      <div className="chat-head">
        <b>☀️ Chat global por voz</b>
        <span className="muted"> · {me.spectator ? "👻 solo escuchas" : <>hablas como <b>{body?.name}</b>, con la voz de su cuerpo</>}</span>
      </div>
      <div className="voice-grid">
        {people.map((p) => (
          <div key={p.id} className={"voice-seat" + (p.id === me.bodyId ? " me" : "")}>
            <span className={"voice-ring" + (v.speaking[p.id] ? " speaking" : "")}>
              <Avatar avatar={p.avatar} color={p.color} size={64} />
            </span>
            <b>{p.name}</b>
            {p.id === me.bodyId && <small>tú</small>}
          </div>
        ))}
      </div>
      <VoiceBar v={v} P={P} />
    </div>
  );
}

/**
 * 🌙 Chat privado por voz: llamadas 1 a 1. Llamar a alguien gasta 1 del cupo (como iniciar un DM);
 * contestar a quien te llama es gratis. Solo se oyen mientras los dos están en la misma llamada.
 */
export function NightVoice({ room, s, players, me, used, P, v, calls, graph }: {
  room: Room; s: StateView; players: PlayerView[]; me: Me; used: number; P: Lookup; v: Voice; calls: CallState; graph: ChatEdge[];
}) {
  const incoming = calls.incoming.join(",");
  const prevIncoming = useRef("");
  useEffect(() => {
    if (incoming && incoming !== prevIncoming.current && calls.incoming.some((b) => !prevIncoming.current.includes(b))) sfx.pop();
    prevIncoming.current = incoming;
  }, [incoming]);

  if (me.spectator) return <ChatGraph players={players} edges={graph} />;

  const others = players.filter((p) => p.id !== me.bodyId && !p.bodyOut);
  const left = Math.max(0, s.chatLimit - used);
  const talked = (id: string) => calls.pairs.includes(id);
  const locked = (id: string) => !talked(id) && left === 0;
  const inCall = (id: string) => calls.target === id && v.peers[id] === "connected";
  const body = P(me.bodyId);
  const who = P(calls.target);

  function call(id: string) {
    if (locked(id) || calls.target === id) return;
    sfx.click();
    room.send("call", { toBody: id });
  }

  return (
    <div className="night">
      <div className="card inbox">
        <div className={"quota" + (left === 0 ? " empty" : "")}>
          <div className="quota-title">📞 Llamadas para iniciar</div>
          <div className="quota-dots">
            {Array.from({ length: s.chatLimit }, (_, i) => <span key={i} className={i < left ? "on" : ""} style={{ animationDelay: `${i * 0.2}s` }}>📞</span>)}
          </div>
          <b>{left}/{s.chatLimit} disponibles</b>
          <p className="small">Contestar a quien te llame es gratis.</p>
        </div>
        <div className="inbox-title">Llamar <small>como {body?.name}</small></div>
        {others.map((p) => {
          const ringing = calls.incoming.includes(p.id);
          const status = inCall(p.id) ? "🟢 En llamada"
            : calls.target === p.id ? "📞 Llamando… (tiene que contestarte)"
            : ringing ? "📲 Te está llamando: toca para contestar"
            : talked(p.id) ? "Ya hablaron · llamar es gratis"
            : locked(p.id) ? "🔒 Ya no te quedan llamadas" : "Toca para llamar · usa 1 📞";
          return (
            <button key={p.id} className={"row" + (calls.target === p.id ? " on" : "") + (locked(p.id) ? " locked" : "") + (ringing ? " incoming" : "")}
              onClick={() => call(p.id)}>
              <span className={"voice-ring" + (v.speaking[p.id] ? " speaking" : "")}>
                <Avatar avatar={p.avatar} color={p.color} size={36} />
              </span>
              <span className="row-meta">
                <span className="row-name">{p.name}</span>
                <span className={"row-pv" + (ringing ? " unread" : "")}>{status}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="card dm voice-call">
        {who ? (
          <>
            <div className="dm-head">
              <Avatar avatar={who.avatar} color={who.color} size={38} />
              <div><b>Cuerpo de {who.name}</b><span>🌙 solo ustedes dos</span></div>
              <span className="dm-moon">🌙</span>
            </div>
            <div className="voice-call-body">
              <span className={"voice-ring" + (v.speaking[who.id] ? " speaking" : "")}>
                <Avatar avatar={who.avatar} color={who.color} size={110} className={inCall(who.id) ? "" : "pulse"} />
              </span>
              <b>{inCall(who.id) ? "🟢 En llamada" : "📞 Llamando…"}</b>
              <p className="muted">{inCall(who.id) ? `Hablas como ${body?.name}, con la voz de su cuerpo.` : `Se conecta cuando ${who.name} te conteste.`}</p>
              <button className="btn" onClick={() => { sfx.click(); room.send("hangup"); }}>📴 Colgar</button>
            </div>
          </>
        ) : <div className="muted center-text night-empty">🌙<br />Elige un cuerpo para llamarlo en privado… o quédate callado 🤫</div>}
        <VoiceBar v={v} P={P} />
      </div>
    </div>
  );
}

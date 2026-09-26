import { useEffect } from "react";
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
 * 🌙 Chat privado por voz: llamadas 1 a 1, ilimitadas pero una a la vez. Quien recibe una llamada oye el timbre
 * y elige contestar o rechazar. Solo se oyen mientras los dos están en la misma llamada.
 */
export function NightVoice({ room, players, me, P, v, calls, graph }: {
  room: Room; s: StateView; players: PlayerView[]; me: Me; used: number; P: Lookup; v: Voice; calls: CallState; graph: ChatEdge[];
}) {
  const ringing = calls.incoming[0]; // la llamada entrante que se muestra (la primera)
  // 📲 El timbre suena mientras haya una llamada entrante sin contestar.
  useEffect(() => {
    if (!ringing || me.spectator) return;
    sfx.ring();
    const iv = setInterval(sfx.ring, 2500);
    return () => clearInterval(iv);
  }, [ringing, me.spectator]);

  if (me.spectator) return <ChatGraph players={players} edges={graph} />;

  const others = players.filter((p) => p.id !== me.bodyId && !p.bodyOut);
  const inCall = (id: string) => calls.target === id && v.peers[id] === "connected";
  const body = P(me.bodyId);
  const who = P(calls.target);
  const caller = P(ringing);

  function call(id: string) {
    if (calls.target === id) return;
    sfx.click();
    room.send("call", { toBody: id }); // si te estaba llamando, esto es contestar
  }
  function decline(id: string) {
    sfx.click();
    room.send("decline", { fromBody: id });
  }

  return (
    <div className="night">
      {caller && (
        <div className="call-incoming pop-in">
          <span className="voice-ring speaking"><Avatar avatar={caller.avatar} color={caller.color} size={48} className="bob" /></span>
          <div><b>📲 Te llama {caller.name}</b><small>{calls.target ? "Si contestas, cuelgas la llamada actual." : "Contesta para hablar en privado."}</small></div>
          <button className="btn" onClick={() => call(caller.id)}>📞 Contestar</button>
          <button className="btn decline" onClick={() => decline(caller.id)}>📵 Rechazar</button>
        </div>
      )}
      <div className="card inbox">
        <div className="quota">
          <div className="quota-title">📞 Llamadas ilimitadas</div>
          <p className="small">Una a la vez: llamar a otro cuelga la actual.</p>
        </div>
        <div className="inbox-title">Llamar <small>como {body?.name}</small></div>
        {others.map((p) => {
          const incoming = calls.incoming.includes(p.id);
          const status = inCall(p.id) ? "🟢 En llamada"
            : calls.target === p.id ? "📞 Llamando…"
            : incoming ? "📲 Te está llamando"
            : calls.pairs.includes(p.id) ? "Ya hablaron · toca para llamar" : "Toca para llamar";
          return (
            <button key={p.id} className={"row" + (calls.target === p.id ? " on" : "") + (incoming ? " incoming" : "")} onClick={() => call(p.id)}>
              <span className={"voice-ring" + (v.speaking[p.id] ? " speaking" : "")}>
                <Avatar avatar={p.avatar} color={p.color} size={36} />
              </span>
              <span className="row-meta">
                <span className="row-name">{p.name}</span>
                <span className={"row-pv" + (incoming ? " unread" : "")}>{status}</span>
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
              <p className="muted">{inCall(who.id) ? `Hablas como ${body?.name}, con la voz de su cuerpo.` : `Se conecta cuando ${who.name} conteste.`}</p>
              <button className="btn decline" onClick={() => { sfx.click(); room.send("hangup"); }}>📴 Colgar</button>
            </div>
          </>
        ) : <div className="muted center-text night-empty">🌙<br />Elige un cuerpo para llamarlo en privado… o quédate callado 🤫</div>}
        <VoiceBar v={v} P={P} />
      </div>
    </div>
  );
}

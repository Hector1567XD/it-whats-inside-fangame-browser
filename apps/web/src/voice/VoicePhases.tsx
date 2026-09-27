import { useEffect } from "react";
import type { Room } from "colyseus.js";
import type { CallState, ChatEdge, PlayerView } from "../net";
import type { Lookup, Me } from "../Chat";
import { Avatar } from "../Avatar";
import { ChatGraph } from "../ChatGraph";
import { sfx } from "../sfx";
import { VoiceBar } from "./VoiceBar";
import type { Voice } from "./useVoice";

/** ☀️ Sala de voz: los cuerpos activos, con el anillo de quién habla. Reemplaza al chat de texto. */
export function VoiceRoom({ v, people, me, P, title = "☀️ Chat global por voz" }: {
  v: Voice; people: PlayerView[]; me: Me; P: Lookup; title?: string;
}) {
  const body = P(me.bodyId);
  return (
    <div className="card voice-room">
      <div className="chat-head">
        <b>{title}</b>
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

/** 🎙️ Tira de voz compacta, para cuando hay voz y texto a la vez (va arriba del chat escrito). */
export function VoiceStrip({ v, people, me, P }: { v: Voice; people: PlayerView[]; me: Me; P: Lookup }) {
  return (
    <div className="voice-strip">
      <div className="voice-strip-heads">
        <span className="voice-strip-label">🎙️ En voz</span>
        {people.map((p) => (
          <span key={p.id} className={"voice-ring" + (v.speaking[p.id] ? " speaking" : "")} title={p.id === me.bodyId ? `${p.name} (tú)` : p.name}>
            <Avatar avatar={p.avatar} color={p.color} size={30} />
          </span>
        ))}
      </div>
      <VoiceBar v={v} P={P} />
    </div>
  );
}

/** 📲 Aviso de una 📻 Llamada de radio entrante, con el timbre sonando hasta que contestes o rechaces. */
export function IncomingCall({ room, calls, me, P }: { room: Room; calls: CallState; me: Me; P: Lookup }) {
  const ringing = calls.incoming[0]; // la llamada entrante que se muestra (la primera)
  useEffect(() => {
    if (!ringing || me.spectator) return;
    sfx.ring();
    const iv = setInterval(sfx.ring, 2500);
    return () => clearInterval(iv);
  }, [ringing, me.spectator]);
  const caller = P(ringing);
  if (!caller || me.spectator) return null;
  return (
    <div className="call-incoming pop-in">
      <span className="voice-ring speaking"><Avatar avatar={caller.avatar} color={caller.color} size={48} className="bob" /></span>
      <div>
        <b>📻 Llamada de radio de {caller.name}</b>
        <small>{calls.target ? "Si contestas, cortas tu llamada de radio actual." : "Contesta para hablar en privado."}</small>
      </div>
      <button className="btn" onClick={() => { sfx.click(); room.send("call", { toBody: caller.id }); }}>📞 Contestar</button>
      <button className="btn decline" onClick={() => { sfx.click(); room.send("decline", { fromBody: caller.id }); }}>📵 Rechazar</button>
    </div>
  );
}

/**
 * 📻 Llamada de radio: llamadas 1 a 1, ilimitadas pero una a la vez. Quien recibe una llamada oye el timbre y elige
 * contestar o rechazar. Solo se oyen mientras los dos están en la misma llamada.
 * `embedded`: va dentro de la noche con chat escrito (el aviso de llamada entrante lo pone la noche).
 */
export function RadioCalls({ room, players, me, P, v, calls, graph, embedded }: {
  room: Room; players: PlayerView[]; me: Me; P: Lookup; v: Voice; calls: CallState; graph: ChatEdge[]; embedded?: boolean;
}) {
  if (me.spectator) return embedded ? null : <ChatGraph players={players} edges={graph} />;

  const others = players.filter((p) => p.id !== me.bodyId && !p.bodyOut);
  const inCall = (id: string) => calls.target === id && v.peers[id] === "connected";
  const body = P(me.bodyId);
  const who = P(calls.target);

  function call(id: string) {
    if (calls.target === id) return;
    sfx.click();
    room.send("call", { toBody: id }); // si te estaba llamando, esto es contestar
  }

  return (
    <div className="night radio">
      {!embedded && <IncomingCall room={room} calls={calls} me={me} P={P} />}
      <div className="card inbox">
        <div className="quota">
          <div className="quota-title">📻 Llamadas de radio ilimitadas</div>
          <p className="small">Una a la vez: llamar a otro corta la actual.</p>
        </div>
        <div className="inbox-title">Llamar por radio <small>como {body?.name}</small></div>
        {others.map((p) => {
          const incoming = calls.incoming.includes(p.id);
          const status = inCall(p.id) ? "🟢 En la radio"
            : calls.target === p.id ? "📻 Llamando…"
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
              <div><b>Cuerpo de {who.name}</b><span>📻 Llamada de radio · solo ustedes dos</span></div>
              <span className="dm-moon">📻</span>
            </div>
            <div className="voice-call-body">
              <span className={"voice-ring" + (v.speaking[who.id] ? " speaking" : "")}>
                <Avatar avatar={who.avatar} color={who.color} size={110} className={inCall(who.id) ? "" : "pulse"} />
              </span>
              <b>{inCall(who.id) ? "🟢 En la radio" : "📻 Llamando…"}</b>
              <p className="muted">{inCall(who.id) ? `Hablas como ${body?.name}, con la voz de su cuerpo.` : `Se conecta cuando ${who.name} conteste.`}</p>
              <button className="btn decline" onClick={() => { sfx.click(); room.send("hangup"); }}>📴 Cortar</button>
            </div>
          </>
        ) : <div className="muted center-text night-empty">📻<br />Elige un cuerpo para llamarlo por radio… o quédate callado 🤫</div>}
        <VoiceBar v={v} P={P} />
      </div>
    </div>
  );
}

import { useState } from "react";
import type { Room } from "colyseus.js";
import { Night, type Lookup, type Me } from "./Chat";
import { sfx } from "./sfx";
import { IncomingCall, RadioCalls } from "./voice/VoicePhases";
import type { Voice } from "./voice/useVoice";
import { channels, type CallState, type ChatEdge, type DmMsg, type PlayerView, type StateView } from "./net";

/**
 * 🌙 La noche (y la fase 📻 Llamada de radio): según la config hay chat privado escrito, Llamadas de radio o ambos.
 * Con ambos a la vez se cambia entre las dos pestañas, y el aviso de llamada entrante sale en cualquiera.
 */
export function PrivatePhase({ room, s, players, me, dms, used, P, typing, seen, graph, voice, calls }: {
  room: Room; s: StateView; players: PlayerView[]; me: Me; dms: Record<string, DmMsg[]>; used: number; P: Lookup;
  typing: Set<string>; seen: Record<string, number>; graph: ChatEdge[]; voice: Voice; calls: CallState;
}) {
  const ch = channels(s.settings, s.phase, s.sfu);
  const radio = ch.voice && voice.inGame;
  const [tab, setTab] = useState<"chat" | "radio">("chat");
  const text = <Night room={room} s={s} players={players} me={me} dms={dms} used={used} P={P} typing={typing} seen={seen} graph={graph} />;
  const calling = <RadioCalls room={room} players={players} me={me} P={P} v={voice} calls={calls} graph={graph} embedded={ch.text} />;
  if (!radio) return text;
  if (!ch.text) return calling;
  if (me.spectator) return text; // el espectador ve el grafo (incluye las llamadas)

  const unread = Object.values(dms).some((list) => list.at(-1) && list.at(-1)!.fromBody !== me.bodyId);
  const radioStatus = calls.incoming.length ? "📲" : calls.target ? "🟢" : "";
  const pick = (t: typeof tab) => { sfx.click(); setTab(t); };
  return (
    <div className="private-both">
      <IncomingCall room={room} calls={calls} me={me} P={P} />
      <div className="tabs">
        <button className={"tab" + (tab === "chat" ? " on" : "")} onClick={() => pick("chat")}>💬 Chat privado{unread && tab !== "chat" ? " •" : ""}</button>
        <button className={"tab" + (tab === "radio" ? " on" : "")} onClick={() => pick("radio")}>📻 Llamada de radio {radioStatus}</button>
      </div>
      {tab === "chat" ? text : calling}
    </div>
  );
}

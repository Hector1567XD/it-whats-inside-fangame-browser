import type { PlayerView } from "../net";
import { sfx } from "../sfx";
import { ENGINE_LABELS } from "./engines";
import { VOICE_TYPES, isVoiceType } from "./presets";
import type { Voice } from "./useVoice";

/** Barra de voz del lobby: mute, ensordecer, ⚙️ reconfigurar y el motor en uso. */
export function VoiceBar({ v, P }: { v: Voice; P: (id: string) => PlayerView | undefined }) {
  const failed = Object.entries(v.peers).filter(([, st]) => st === "failed").map(([id]) => P(id)?.name ?? "?");
  if (v.mode === "off") {
    return (
      <div className="voice-bar">
        <button className="chip" onClick={() => { sfx.click(); v.openSetup(); }}>🎙️ Unirme al chat de voz</button>
        {v.error && <span className="voice-note bad">{v.error}</span>}
      </div>
    );
  }
  return (
    <div className="voice-bar">
      {v.mode === "mic" && (
        <button className={"chip" + (v.muted ? " off" : " on")} onClick={() => { sfx.click(); v.toggleMute(); }} title={v.muted ? "Activar micrófono" : "Silenciar micrófono"}>
          {v.muted ? "🔇 Muteado" : "🎙️ Micrófono"}
        </button>
      )}
      <button className={"chip" + (v.deaf ? " off" : "")} onClick={() => { sfx.click(); v.toggleDeaf(); }} title={v.deaf ? "Volver a oír" : "Silenciar todo lo que llega"}>
        {v.deaf ? "🔕 Ensordecido" : "🔈 Oyendo"}
      </button>
      <button className="chip" onClick={() => { sfx.click(); v.openSetup(); }} title="Reconfigurar la voz">⚙️</button>
      <span className="voice-note">
        {v.mode === "listen" ? "🎧 Solo escuchas" : v.inGame ? "🎭 Voz de tu cuerpo" : v.profile && isVoiceType(v.profile.voice) && `${VOICE_TYPES[v.profile.voice].icon} ${VOICE_TYPES[v.profile.voice].label}`}
        {v.engine && ` · motor: ${ENGINE_LABELS[v.engine]}`}
        {v.transport && (v.transport === "sfu" ? " · vía servidor" : " · P2P")}
      </span>
      {v.blocked && <button className="chip warn" onClick={() => { sfx.click(); v.unblock(); }}>🔈 Activar audio</button>}
      {v.problem && <span className="voice-note bad">{v.problem}</span>}
      {failed.length > 0 && <span className="voice-note bad">No se pudo conectar con {failed.join(", ")} <small>(detalle en la consola, [voz])</small></span>}
    </div>
  );
}

/** Icono de voz de un jugador en la lista del lobby. */
export function voiceIcon(p: PlayerView) {
  if (isVoiceType(p.voice)) return VOICE_TYPES[p.voice].icon + (p.micOn ? "" : " 🔇");
  return "🙊"; // sin micrófono (solo escucha o fuera de la voz)
}

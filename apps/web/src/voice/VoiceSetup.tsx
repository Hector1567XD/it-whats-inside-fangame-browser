import { useState } from "react";
import { createPortal } from "react-dom";
import { sfx } from "../sfx";
import { medianF0 } from "./pitch";
import { DEFAULT_F0, VOICE_TYPES, paramsFor, type VoiceType } from "./presets";
import { ENGINE_LABELS } from "./engines";
import type { Voice } from "./useVoice";

type Step = "start" | "type" | "calibrate" | "listen";
const RECORD_MS = 3000;

/**
 * 🎙️ Modal de voz del lobby: permiso → tipo de voz → calibrar (3 s) → escúchate → ¡listo!
 * Con un perfil guardado solo pide el permiso. Se reabre con ⚙️ desde la barra de voz.
 */
export function VoiceSetup({ v }: { v: Voice }) {
  const reopening = v.mode === "mic"; // ⚙️ con la voz ya andando: directo a elegir la voz
  const [step, setStep] = useState<Step>(reopening ? "type" : "start");
  const [voice, setVoice] = useState<VoiceType>(v.profile?.voice ?? "neutral");
  const [f0, setF0] = useState(v.profile?.f0 ?? DEFAULT_F0);
  const [measured, setMeasured] = useState<"" | "ok" | "none">("");
  const [take, setTake] = useState<AudioBuffer | null>(null);
  const [busy, setBusy] = useState<"" | "mic" | "rec" | "play">("");
  const [left, setLeft] = useState(0);
  const [err, setErr] = useState(v.error);

  async function activate(full: boolean) {
    sfx.click();
    setBusy("mic");
    setErr("");
    try {
      await v.ensureChain();
      if (!full && v.profile) return v.finish("mic", v.profile);
      setStep("type");
    } catch (e: any) {
      sfx.error();
      setErr(e?.name === "NotAllowedError"
        ? "El navegador no dio permiso para el micrófono. Puedes entrar solo a escuchar."
        : `No se pudo abrir el micrófono: ${e?.message ?? e}`);
    } finally {
      setBusy("");
    }
  }

  async function record() {
    sfx.click();
    setBusy("rec");
    setErr("");
    setLeft(RECORD_MS / 1000);
    const iv = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000);
    try {
      const chain = await v.ensureChain();
      const buf = await chain.record(RECORD_MS);
      const f = medianF0(buf);
      setMeasured(f ? "ok" : "none");
      if (f) setF0(Math.round(f));
      setTake(buf);
      setStep("listen");
      void play(buf, f ? Math.round(f) : f0);
    } catch (e: any) {
      sfx.error();
      setErr(`No se pudo grabar: ${e?.message ?? e}`);
    } finally {
      clearInterval(iv);
      setBusy("");
    }
  }

  async function play(buf = take, base = f0) {
    if (!buf) return;
    setBusy("play");
    try {
      const chain = await v.ensureChain();
      await chain.previewBuffer(buf, paramsFor(voice, v.predictVariant(voice), base), v.walkie);
    } catch (e: any) {
      setErr(`No se pudo reproducir: ${e?.message ?? e}`);
    } finally {
      setBusy("");
    }
  }

  const done = () => {
    sfx.boing();
    v.chain.current?.stopPreview();
    v.finish("mic", { voice, f0 });
  };
  const close = () => {
    v.chain.current?.stopPreview();
    v.closeSetup();
  };
  const engine = v.chain.current?.engineId;

  return createPortal(
    <div className="modal-bg" onClick={close}>
      <div className="card modal voice-setup" onClick={(e) => e.stopPropagation()}>
        {step === "start" && (
          <>
            <h2>🎙️ Chat de voz</h2>
            <p>En la sala de espera se habla por voz, pero <b>nadie oye tu voz real</b>: todos oyen una voz modulada, «la estática de tu cuerpo». 🎧 Mejor con audífonos.</p>
            {v.profile ? (
              <>
                <button className="btn big" disabled={!!busy} onClick={() => activate(false)}>
                  🎙️ Activar micrófono <small>· {VOICE_TYPES[v.profile.voice].icon} {VOICE_TYPES[v.profile.voice].label}</small>
                </button>
                <button className="chip" disabled={!!busy} onClick={() => activate(true)}>🎚️ Cambiar mi voz</button>
              </>
            ) : (
              <button className="btn big" disabled={!!busy} onClick={() => activate(true)}>🎙️ Activar micrófono</button>
            )}
            <button className="chip" disabled={!!busy} onClick={() => { sfx.click(); v.ensureCtx(); v.finish("listen"); }}>🎧 Entrar sin micrófono (solo escuchar)</button>
            <button className="chip ghost" disabled={!!busy} onClick={() => { sfx.click(); v.finish("off"); }}>Saltar</button>
          </>
        )}

        {step === "type" && (
          <>
            <h2>🎭 Elige tu voz</h2>
            <p className="muted">Si alguien más elige la misma, cada quien suena un poco distinto.</p>
            <div className="mode-pick voice-pick">
              {(Object.keys(VOICE_TYPES) as VoiceType[]).map((t) => (
                <button key={t} className={"mode" + (t === voice ? " on" : "")} onClick={() => { sfx.click(); setVoice(t); }}>
                  <span className="mode-icon">{VOICE_TYPES[t].icon}</span>
                  <b>{VOICE_TYPES[t].label}</b>
                  <small>{VOICE_TYPES[t].desc}</small>
                </button>
              ))}
            </div>
            <button className="btn big" onClick={() => { sfx.click(); setStep(take ? "listen" : "calibrate"); }}>Siguiente →</button>
          </>
        )}

        {step === "calibrate" && (
          <>
            <h2>📏 Calibrar</h2>
            <p>Al grabar, di: <b>«hola, soy yo y esta es mi voz»</b>. Medimos tu tono para que la voz modulada suene bien.</p>
            <button className={"btn big" + (busy === "rec" ? " recording" : "")} disabled={!!busy} onClick={record}>
              {busy === "rec" ? `⏺️ Habla… ${left} s` : "⏺️ Grabar 3 s"}
            </button>
            <button className="chip ghost" disabled={!!busy} onClick={done}>Saltar (usar {v.profile ? "mi tono guardado" : "un tono estándar"})</button>
          </>
        )}

        {step === "listen" && (
          <>
            <h2>👂 Escúchate</h2>
            <p className="muted">
              {measured === "ok" ? `Tu tono base: ${f0} Hz.` : "No detectamos tu tono (habla un poco más fuerte); usamos uno estándar."}
              {engine && ` Motor: ${ENGINE_LABELS[engine]}.`}
            </p>
            <div className="row">
              <button className="btn" disabled={!!busy} onClick={() => { sfx.click(); void play(); }}>{busy === "play" ? "🔊 Sonando…" : "▶ Escúchate"}</button>
              <button className="chip" disabled={!!busy} onClick={() => setStep("calibrate")}>⏺️ Grabar de nuevo</button>
              <button className="chip" disabled={!!busy} onClick={() => setStep("type")}>🎭 Otra voz</button>
            </div>
            <button className="btn big" disabled={busy === "rec"} onClick={done}>¡Listo!</button>
          </>
        )}

        {err && <div className="err">{err}</div>}
      </div>
    </div>,
    document.body,
  );
}

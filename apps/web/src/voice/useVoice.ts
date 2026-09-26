import { useEffect, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import type { StateView } from "../net";
import { VoiceChain, type WalkieLevel } from "./chain";
import { VoiceMesh } from "./mesh";
import { VoiceSfu } from "./sfu";
import { sfuRequest } from "./rpc";
import type { VoiceTransport } from "./transport";
import { DEFAULT_F0, isVoiceType, paramsFor, type VoiceType } from "./presets";
import type { EngineId } from "./engines";

export type VoiceMode = "off" | "mic" | "listen";
export type VoiceProfile = { voice: VoiceType; f0: number };

const PROFILE_KEY = "lqha:voice";
const SPEAKING = 0.06; // umbral de nivel para el anillo de "hablando"

function loadProfile(): VoiceProfile | null {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? "null");
    return p && isVoiceType(p.voice) ? { voice: p.voice, f0: Number(p.f0) || DEFAULT_F0 } : null;
  } catch {
    return null;
  }
}
function saveProfile(p: VoiceProfile) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {}
}

/**
 * Voz: el modal, la cadena (mic → voz modulada) y el transporte (SFU de Cloudflare o malla P2P).
 * Vive en el LOBBY y, si el host activó "Chat global y privado por voz" (requiere el SFU), toda la partida:
 * ahí el server decide qué voces oye cada quien y tu voz suena con la del DUEÑO DEL CUERPO que ocupas.
 * Al terminar se cierran los peers, se suelta el micrófono y se cierra el AudioContext; al volver al lobby
 * se rearma solo con la elección que hizo el jugador en esta sesión.
 */
export function useVoice(room: Room, s: StateView | null, me: { mindId: string; bodyId: string } | null) {
  const myId = me?.mindId;
  const [mode, setMode] = useState<VoiceMode>("off");
  const [decided, setDecided] = useState(false); // ya respondió el modal en esta sesión
  const [setupOpen, setSetupOpen] = useState(false); // reabierto con ⚙️
  const [profile, setProfile] = useState(loadProfile);
  const [muted, setMuted] = useState(false);
  const [deaf, setDeaf] = useState(false);
  const [engine, setEngine] = useState<EngineId | null>(null);
  const [speaking, setSpeaking] = useState<Record<string, boolean>>({});
  const [peers, setPeers] = useState<Record<string, RTCPeerConnectionState>>({});
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const ctxRef = useRef<AudioContext | null>(null);
  const chainRef = useRef<VoiceChain | null>(null);
  const meshRef = useRef<VoiceTransport | null>(null);
  const [transport, setTransport] = useState<"sfu" | "p2p" | null>(null);
  const [problem, setProblem] = useState("");
  const idsRef = useRef<string[]>([]);
  const opening = useRef<Promise<VoiceChain> | null>(null);
  const lastEngine = useRef<EngineId | null>(null);
  const selfRef = useRef("");

  const inLobby = s?.phase === "LOBBY";
  const inGame = !!s && !inLobby && s.settings.voicePhases && s.sfu;
  const active = inLobby || inGame;
  const mine = myId ? s?.players[myId] : undefined;
  const variant = mine?.voiceVariant ?? 0;
  const walkie = (s?.settings.voiceWalkie ?? 0) as WalkieLevel;
  // En partida hablas "desde tu cuerpo": su voz es la de su dueño. En lobby y resultados, la tuya.
  const byBody = inGame && s?.phase !== "RESULTS";
  const selfLabel = (byBody ? me?.bodyId : myId) ?? "";
  const params = voiceParams();
  const paramsKey = JSON.stringify(params);
  const live = useRef({ muted, walkie, params });
  live.current = { muted, walkie, params };
  selfRef.current = selfLabel;

  /** Parámetros de la voz que sale: tu tipo y variante, o los del dueño del cuerpo (con tu tono base). */
  function voiceParams() {
    const f0 = profile?.f0;
    const owner = byBody && s ? s.players[me?.bodyId ?? ""] : undefined;
    if (!owner) return paramsFor(profile?.voice ?? "neutral", variant, f0);
    if (isVoiceType(owner.voice)) return paramsFor(owner.voice, owner.voiceVariant, f0);
    // El dueño no eligió voz: una neutra propia de ese cuerpo, distinta de las elegidas.
    const typeless = Object.values(s!.players).filter((p) => !isVoiceType(p.voice)).map((p) => p.id);
    return paramsFor("neutral", 5 + Math.max(0, typeless.indexOf(owner.id)), f0);
  }

  function ensureCtx() {
    if (!ctxRef.current || ctxRef.current.state === "closed") ctxRef.current = new AudioContext();
    void ctxRef.current.resume();
    return ctxRef.current;
  }

  /** Abre el micrófono una sola vez (el modal lo llama desde el toque del botón) y devuelve la cadena. */
  function ensureChain(): Promise<VoiceChain> {
    const ctx = ensureCtx();
    if (chainRef.current) return Promise.resolve(chainRef.current);
    opening.current ??= VoiceChain.open(ctx, lastEngine.current)
      .then((chain) => {
        if (ctxRef.current !== ctx) {
          chain.destroy(); // se desarmó todo mientras pedíamos el permiso
          throw new Error("cancelado");
        }
        return (chainRef.current = chain);
      })
      .finally(() => { opening.current = null; });
    return opening.current;
  }

  function dropMesh() {
    meshRef.current?.destroy();
    meshRef.current = null;
    setSpeaking({});
    setPeers({});
    setBlocked(false);
    setProblem("");
    setTransport(null);
  }

  /** Suelta todo: peers, micrófono y AudioContext. */
  function teardown() {
    dropMesh();
    chainRef.current?.destroy();
    chainRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setEngine(null);
  }

  /** Cierra el modal: con micrófono, solo escuchando o sin voz ("Ahora no"). */
  function finish(next: VoiceMode, p?: VoiceProfile) {
    if (p) {
      saveProfile(p);
      setProfile(p);
    }
    setDecided(true);
    setSetupOpen(false);
    setError("");
    if (next === "off") teardown(); // soltar el micrófono que abrió el modal
    setMode(next);
  }

  // Sin transporte activo igual llegan estos mensajes: handlers vacíos para que colyseus.js no avise.
  useEffect(() => {
    const offs = ["rtc", "sfu", "sfuPubs"].map((t) => room.onMessage(t, () => {}));
    return () => offs.forEach((off) => off());
  }, [room]);

  // Si el AudioContext quedó suspendido (se creó sin un toque, p. ej. al volver al lobby), cualquier toque lo reactiva.
  useEffect(() => {
    const wake = () => {
      const ctx = ctxRef.current;
      if (ctx && ctx.state !== "running" && ctx.state !== "closed") {
        void ctx.resume().then(() => { console.info("[voz] audio reactivado con un toque"); meshRef.current?.unblock(); setBlocked(false); });
      }
    };
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    return () => { window.removeEventListener("pointerdown", wake); window.removeEventListener("keydown", wake); };
  }, []);

  // Sin voz en esta fase (o al desmontar) se suelta todo.
  useEffect(() => {
    if (!active) teardown();
  }, [active]);
  useEffect(() => teardown, []);

  // Arma el transporte (y la cadena si hay micrófono) con la voz activa y una elección hecha.
  useEffect(() => {
    if (!active || mode === "off" || !myId) return;
    let cancelled = false;
    (async () => {
      try {
        const ctx = ensureCtx();
        let track: MediaStreamTrack | null = null;
        if (mode === "mic") {
          const { params: pr, walkie: w, muted: m } = live.current;
          const chain = await ensureChain();
          if (cancelled) return;
          await chain.start(pr, w);
          if (cancelled) return;
          chain.setMuted(m);
          setEngine(chain.engineId);
          lastEngine.current = chain.engineId;
          track = chain.outputTrack;
        } else if (chainRef.current) {
          chainRef.current.destroy(); // pasó a solo escuchar: soltar el micrófono
          chainRef.current = null;
          setEngine(null);
        }
        // Primero el perfil y después los `hello`: así los demás ya nos cuentan en la voz cuando llegan.
        // (en partida el server lo ignora: ver quién se mutea delataría su mente)
        room.send("voiceProfile", mode === "mic"
          ? { voice: profile?.voice ?? "neutral", micOn: !live.current.muted }
          : { voice: "listen", micOn: false });
        // Con el SFU de Cloudflare configurado en el server, el audio pasa por él; si no, malla P2P.
        const cfg = await sfuRequest<{ sfu: boolean; iceServers: RTCIceServer[] }>(room, "config", {}, 5000)
          .catch(() => ({ sfu: false, iceServers: [] }));
        if (cancelled) return;
        // La malla P2P delataría quién está en cada cuerpo: en partida solo hay voz con el SFU.
        if (!cfg.sfu && !inLobby) return;
        const mesh: VoiceTransport = cfg.sfu ? new VoiceSfu(room, myId, ctx, track, cfg.iceServers) : new VoiceMesh(room, myId, ctx, track);
        setTransport(cfg.sfu ? "sfu" : "p2p");
        mesh.onChange = () => {
          setPeers({ ...mesh.state });
          setBlocked(mesh.blocked);
          setProblem(mesh.problem);
        };
        mesh.deafen(deaf);
        meshRef.current = mesh;
        mesh.sync(idsRef.current);
        if (ctx.state !== "running") setBlocked(true);
        console.info(`[voz] audio por Web Audio · AudioContext: ${ctx.state}${ctx.state !== "running" ? " (toca la página para activarlo)" : ""}`);
        setError("");
      } catch (e: any) {
        if (cancelled) return;
        console.warn("[voz]", e);
        setError(e?.name === "NotAllowedError" ? "No hay permiso para el micrófono." : `No se pudo activar la voz: ${e?.message ?? e}`);
        setMode("off");
      }
    })();
    return () => {
      cancelled = true;
      dropMesh();
    };
  }, [active, mode, myId]);

  // Sin voz en esta sesión (o recién reconectado): que el server no nos anuncie como disponibles.
  useEffect(() => {
    if (inLobby && mode === "off" && mine && (mine.voice !== "" || mine.micOn)) room.send("voiceProfile", { voice: "", micOn: false });
  }, [inLobby, mode, mine?.voice, mine?.micOn]);

  // Con quién conectarse: los conectados que están en la voz. Entre dos que solo escuchan no hace falta.
  const ids = s && myId && inLobby && mode !== "off"
    ? Object.values(s.players)
        .filter((p) => p.id !== myId && p.connected && p.voice !== "" && (mode === "mic" || p.voice !== "listen"))
        .map((p) => p.id)
    : [];
  idsRef.current = ids;
  const idsKey = ids.join(",");
  useEffect(() => { meshRef.current?.sync(ids); }, [idsKey]);

  // Cambios sin reconectar: variante, tono base, tipo, cuerpo (al cambiar de cuerpo), walkie, mute, ensordecer.
  useEffect(() => {
    if (mode === "mic") chainRef.current?.setParams(params);
  }, [mode, paramsKey]);
  useEffect(() => { chainRef.current?.setWalkie(walkie); }, [walkie]);
  useEffect(() => {
    chainRef.current?.setMuted(muted);
    if (inLobby && mode === "mic" && meshRef.current) room.send("voiceProfile", { voice: profile?.voice ?? "neutral", micOn: !muted });
  }, [muted, profile?.voice]);
  useEffect(() => { meshRef.current?.deafen(deaf); }, [deaf]);

  // Anillo de "hablando": nivel local (voz procesada) y de cada peer.
  useEffect(() => {
    if (!active || mode === "off") return;
    let prev = "";
    const iv = setInterval(() => {
      const next: Record<string, boolean> = {};
      const levels = meshRef.current?.levels() ?? {};
      for (const [id, l] of Object.entries(levels)) if (l > SPEAKING) next[id] = true;
      if (selfRef.current && chainRef.current && !live.current.muted && chainRef.current.level() > SPEAKING) next[selfRef.current] = true;
      const key = Object.keys(next).sort().join(",");
      if (key !== prev) {
        prev = key;
        setSpeaking(next);
      }
    }, 100);
    return () => clearInterval(iv);
  }, [active, mode, myId]);

  /** Variante que probablemente te toque con ese tipo (el server asigna por orden de llegada = orden del mapa). */
  function predictVariant(type: VoiceType) {
    if (!s || !myId) return 0;
    if (mine?.voice === type) return variant;
    const same = Object.values(s.players).filter((p) => p.id === myId || p.voice === type);
    return Math.max(0, same.findIndex((p) => p.id === myId));
  }

  return {
    mode, profile, muted, deaf, engine, speaking, peers, blocked, error, walkie, transport, problem, inGame, selfLabel,
    showSetup: active && (setupOpen || (inLobby && !decided && mode === "off")),
    chain: chainRef,
    ensureCtx, ensureChain, finish, predictVariant,
    openSetup: () => setSetupOpen(true),
    closeSetup: () => (decided ? setSetupOpen(false) : finish("off")),
    toggleMute: () => setMuted((m) => !m),
    toggleDeaf: () => setDeaf((d) => !d),
    unblock: () => {
      void ctxRef.current?.resume();
      meshRef.current?.unblock();
      setBlocked(false);
    },
  };
}

export type Voice = ReturnType<typeof useVoice>;

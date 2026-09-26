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
 * Voz del lobby: el modal, la cadena (mic → voz modulada) y la malla P2P.
 * Todo vive solo mientras la fase es LOBBY; al salir se cierran los peers, se suelta el micrófono y se cierra
 * el AudioContext. Al volver al lobby se rearma solo con la elección que hizo el jugador en esta sesión.
 */
export function useVoice(room: Room, s: StateView | null, myId: string | undefined) {
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

  const inLobby = s?.phase === "LOBBY";
  const mine = myId ? s?.players[myId] : undefined;
  const variant = mine?.voiceVariant ?? 0;
  const walkie = (s?.settings.voiceWalkie ?? 0) as WalkieLevel;
  const live = useRef({ muted, walkie, variant, profile });
  live.current = { muted, walkie, variant, profile };

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

  // Fuera del lobby (o al desmontar) se suelta todo.
  useEffect(() => {
    if (!inLobby) teardown();
  }, [inLobby]);
  useEffect(() => teardown, []);

  // Arma la malla (y la cadena si hay micrófono) al estar en el lobby con una elección hecha.
  useEffect(() => {
    if (!inLobby || mode === "off" || !myId) return;
    let cancelled = false;
    (async () => {
      try {
        const ctx = ensureCtx();
        let track: MediaStreamTrack | null = null;
        if (mode === "mic") {
          const { profile: p, variant: v, walkie: w, muted: m } = live.current;
          const chain = await ensureChain();
          if (cancelled) return;
          await chain.start(paramsFor(p?.voice ?? "neutral", v, p?.f0), w);
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
        const p = live.current.profile;
        room.send("voiceProfile", mode === "mic"
          ? { voice: p?.voice ?? "neutral", micOn: !live.current.muted }
          : { voice: "listen", micOn: false });
        // Con el SFU de Cloudflare configurado en el server, el audio pasa por él; si no, malla P2P.
        const cfg = await sfuRequest<{ sfu: boolean; iceServers: RTCIceServer[] }>(room, "config", {}, 5000)
          .catch(() => ({ sfu: false, iceServers: [] }));
        if (cancelled) return;
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
  }, [inLobby, mode, myId]);

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

  // Cambios sin reconectar: variante, tono base, tipo, walkie, mute, ensordecer.
  useEffect(() => {
    if (mode !== "mic" || !profile) return;
    chainRef.current?.setParams(paramsFor(profile.voice, variant, profile.f0));
  }, [mode, profile?.voice, profile?.f0, variant]);
  useEffect(() => { chainRef.current?.setWalkie(walkie); }, [walkie]);
  useEffect(() => {
    chainRef.current?.setMuted(muted);
    if (inLobby && mode === "mic" && meshRef.current) room.send("voiceProfile", { voice: profile?.voice ?? "neutral", micOn: !muted });
  }, [muted, profile?.voice]);
  useEffect(() => { meshRef.current?.deafen(deaf); }, [deaf]);

  // Anillo de "hablando": nivel local (voz procesada) y de cada peer.
  useEffect(() => {
    if (!inLobby || mode === "off") return;
    let prev = "";
    const iv = setInterval(() => {
      const next: Record<string, boolean> = {};
      const levels = meshRef.current?.levels() ?? {};
      for (const [id, l] of Object.entries(levels)) if (l > SPEAKING) next[id] = true;
      if (myId && chainRef.current && !live.current.muted && chainRef.current.level() > SPEAKING) next[myId] = true;
      const key = Object.keys(next).sort().join(",");
      if (key !== prev) {
        prev = key;
        setSpeaking(next);
      }
    }, 100);
    return () => clearInterval(iv);
  }, [inLobby, mode, myId]);

  /** Variante que probablemente te toque con ese tipo (el server asigna por orden de llegada = orden del mapa). */
  function predictVariant(type: VoiceType) {
    if (!s || !myId) return 0;
    if (mine?.voice === type) return variant;
    const same = Object.values(s.players).filter((p) => p.id === myId || p.voice === type);
    return Math.max(0, same.findIndex((p) => p.id === myId));
  }

  return {
    mode, profile, muted, deaf, engine, speaking, peers, blocked, error, walkie, transport, problem,
    showSetup: inLobby && (setupOpen || (!decided && mode === "off")),
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

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Room } from "colyseus.js";
import {
  client, saveReconnect, loadReconnect, clearReconnect, roomInfo, autoChats, autoCycles, skipNeeded, isImmutableMode, MODES,
  type StateView, type ChatMsg, type DmMsg, type ResultsPayload, type PlayerView, type Settings, type Mode, type Phase,
  type Role, type Verdict, type ChatEdge, type CallState, type NightMode, ghostCount, channels, hasRadioPhase,
} from "./net";
import { Avatar, STYLES, STYLE_IDS, randomSeed, validAvatar, type StyleId } from "./Avatar";
import { PhaseBanner, Stars, SwapScreen } from "./Overlay";
import { GroupChat, type Lookup, type Me } from "./Chat";
import { DayView, Guess, QuestionPhase, ThreadPhase, type Social } from "./Phases";
import { Results } from "./Results";
import { RoundDetailsView } from "./Details";
import { ExactPhase } from "./Exact";
import { PrivatePhase } from "./Private";
import { SpectatorNote, VerdictScreen, VotePhase, type Floater } from "./Vote";
import { sfx, isMuted, setMuted } from "./sfx";
import { SONGS, setMusic } from "./music";
import { useVoice, type Voice } from "./voice/useVoice";
import { VoiceSetup } from "./voice/VoiceSetup";
import { VoiceBar, voiceIcon } from "./voice/VoiceBar";
import { VoiceStrip } from "./voice/VoicePhases";
import { WALKIE_LABELS } from "./voice/chain";

const COLORS = ["#ff4d8d", "#ff8a3d", "#ffd23d", "#5ee37a", "#3dd6ff", "#6c7bff", "#b36bff", "#ffffff"];
const randomColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];
const codeFromUrl = () => new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
const load = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };

const PLAYING: Phase[] = ["SWAP", "QUESTION", "THREAD", "DAY", "NIGHT", "RADIO", "UNMASK", "VOTE", "VERDICT", "GUESS", "FINAL_VOTE", "EXACT"];
const SKIPPABLE: Phase[] = ["QUESTION", "THREAD", "DAY", "NIGHT", "RADIO", "UNMASK", "VOTE", "GUESS", "FINAL_VOTE", "EXACT"];

export default function App() {
  const [room, setRoom] = useState<Room | null>(null);
  const [booting, setBooting] = useState(true);
  const [notice, setNotice] = useState("");

  // Intentar reconectar si recargaste la página estando en una sala
  useEffect(() => {
    const saved = loadReconnect();
    const code = codeFromUrl();
    if (saved && (!code || code === saved.roomId)) {
      client.reconnect(saved.token).then(onRoom).catch(clearReconnect).finally(() => setBooting(false));
    } else setBooting(false);
  }, []);

  function onRoom(r: Room) {
    saveReconnect(r);
    history.replaceState(null, "", `?room=${r.roomId}`);
    setNotice("");
    r.onMessage("kicked", ({ message }: { message: string }) => setNotice(message));
    r.onLeave(() => {
      clearReconnect();
      setRoom(null);
    });
    setRoom(r);
  }

  if (booting) return <div className="center"><div className="loader">🎭</div></div>;
  return room ? <Game room={room} /> : <Home onRoom={onRoom} notice={notice} />;
}

// ======================= HOME =======================

type Rejoin = { code: string; names: string[]; suggested?: string };

function Home({ onRoom, notice }: { onRoom: (r: Room) => void; notice: string }) {
  const [name, setName] = useState(() => load("lqha:name") ?? "");
  const [color, setColor] = useState(() => load("lqha:color") ?? randomColor());
  const [avatar, setAvatar] = useState(() => validAvatar(load("lqha:avatar")));
  const [mode, setMode] = useState<Mode>(() => { const m = load("lqha:mode"); return m && m in MODES ? (m as Mode) : "classic"; });
  const [code, setCode] = useState(codeFromUrl());
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const linked = codeFromUrl();
  const style = avatar.split(":")[0] as StyleId;
  const [options, setOptions] = useState(() => Array.from({ length: 5 }, randomSeed));
  const [how, setHow] = useState(false);
  const [rejoin, setRejoin] = useState<Rejoin | null>(null);

  async function go(kind: "create" | "join", takeoverAs?: string) {
    const n = (takeoverAs ?? name).trim();
    if (!n) { sfx.error(); return setErr("Pon tu username"); }
    save("lqha:name", n); save("lqha:color", color); save("lqha:avatar", avatar); save("lqha:mode", mode);
    setErr(""); setBusy(true); sfx.boing();
    try {
      const opts = { name: n, color, avatar, mode, takeover: !!takeoverAs };
      if (kind === "create") onRoom(await client.create("game", opts));
      else {
        const c = code.trim().toUpperCase();
        if (!takeoverAs) {
          const info = await roomInfo(c);
          if (!info.exists) throw new Error("Esa sala no existe");
          const names = info.names ?? [];
          const same = names.find((x) => x.toLowerCase() === n.toLowerCase());
          // Mismo nombre que alguien de la sala, o partida en curso: preguntar si quiere retomar un lugar.
          if (same || info.phase !== "LOBBY") return setRejoin({ code: c, names, suggested: same });
        }
        setRejoin(null);
        onRoom(await client.joinById(c, opts));
      }
    } catch (e: any) {
      sfx.error();
      setErr(e?.message ?? "Error");
    } finally { setBusy(false); }
  }

  const pickStyle = (id: StyleId) => { sfx.click(); setAvatar(`${id}:${avatar.split(":")[1]}`); };
  const reroll = () => {
    sfx.pop();
    const st = STYLE_IDS[Math.floor(Math.random() * STYLE_IDS.length)];
    setAvatar(`${st}:${randomSeed()}`);
    setColor(randomColor());
    setOptions(Array.from({ length: 5 }, randomSeed));
  };

  return (
    <div className="center home-wrap">
      <Floaties />
      {how && <HowToPlay onClose={() => setHow(false)} />}
      {rejoin && (
        <RejoinModal r={rejoin} busy={busy} onPick={(n) => { setName(n); go("join", n); }} onClose={() => setRejoin(null)} />
      )}
      <div className="card home pop-in">
        <h1 className="logo">MIND<span>SWAP</span></h1>
        <p className="sub">Cambia de cuerpo. Descubre quién es quién.<br /><em>Al final, lo que importa es lo que hay adentro 😉</em></p>
        <button className="chip how-btn" onClick={() => { sfx.pop(); setHow(true); }}>❓ Cómo se juega</button>

        <div className="avatar-pick">
          <Avatar avatar={avatar} color={color} size={110} className="bob" key={avatar + color} />
          <button className="dice" onClick={reroll} title="Avatar y color al azar">🎲</button>
        </div>
        <div className="style-tabs">
          {STYLE_IDS.map((id) => (
            <button key={id} className={"style-tab" + (id === style ? " on" : "")} onClick={() => pickStyle(id)}>
              <Avatar avatar={`${id}:${avatar.split(":")[1]}`} color={color} size={30} />
              {STYLES[id].label}
            </button>
          ))}
        </div>
        <div className="variants">
          {options.map((seed) => (
            <button key={seed} className="variant" onClick={() => { sfx.pop(); setAvatar(`${style}:${seed}`); }}>
              <Avatar avatar={`${style}:${seed}`} color={color} size={48} />
            </button>
          ))}
        </div>
        <div className="swatches">
          {COLORS.map((c) => (
            <button key={c} className={"swatch" + (c === color ? " on" : "")} style={{ background: c }} onClick={() => { sfx.click(); setColor(c); }} />
          ))}
        </div>

        {!linked && <ModePicker mode={mode} onChange={(m) => { sfx.click(); setMode(m); }} />}

        <input value={name} maxLength={16} placeholder="Tu username" onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go(linked ? "join" : "create")} />
        {linked ? (
          <button className="btn big" disabled={busy} onClick={() => go("join")}>ENTRAR A {linked}</button>
        ) : (
          <>
            <button className="btn big" disabled={busy} onClick={() => go("create")}>▶ CREAR SALA</button>
            <div className="row">
              <input className="code" value={code} maxLength={4} placeholder="CÓDIGO" onChange={(e) => setCode(e.target.value.toUpperCase())} />
              <button className="btn" disabled={busy || code.length < 4} onClick={() => go("join")}>Unirse</button>
            </div>
          </>
        )}
        {notice && <div className="err">{notice}</div>}
        {err && <div className="err shake">{err}</div>}
        <p className="credits">Avatares: <a href="https://www.dicebear.com" target="_blank" rel="noreferrer">DiceBear</a> · Big Smile (Ashley Seo), Adventurer (Lisa Wischofsky), Croodles (vijay verma) — CC BY 4.0</p>
      </div>
    </div>
  );
}

function ModePicker({ mode, onChange, disabled }: { mode: Mode; onChange: (m: Mode) => void; disabled?: boolean }) {
  return (
    <div className="mode-pick">
      {(Object.keys(MODES) as Mode[]).map((m) => (
        <button key={m} disabled={disabled} className={"mode" + (m === mode ? " on" : "")} onClick={() => onChange(m)}>
          <span className="mode-icon">{MODES[m].icon}</span>
          <b>{MODES[m].label}</b>
          <small>{MODES[m].desc}</small>
        </button>
      ))}
    </div>
  );
}

function RejoinModal({ r, busy, onPick, onClose }: { r: Rejoin; busy: boolean; onPick: (name: string) => void; onClose: () => void }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="card modal rejoin" onClick={(e) => e.stopPropagation()}>
        {r.suggested ? (
          <>
            <h2>🤔 Ya hay un «{r.suggested}» en la sala</h2>
            <p>¿Eres tú? Si confirmas, <b>tomas su lugar</b>: su cuerpo, sus puntos y sus chats. Si esa persona sigue conectada, saldrá de la sala.</p>
            <button className="btn big" disabled={busy} onClick={() => onPick(r.suggested!)}>✅ Sí, soy {r.suggested} — reconectar</button>
            <button className="chip" onClick={onClose}>✏️ No, voy a cambiar mi nombre</button>
          </>
        ) : (
          <>
            <h2>🔒 La partida ya empezó</h2>
            <p>Si estabas jugando y se te cayó la conexión, elige quién eras para retomar tu lugar:</p>
            <div className="rejoin-names">
              {r.names.map((n) => <button key={n} className="btn" disabled={busy} onClick={() => onPick(n)}>{n}</button>)}
            </div>
            <button className="chip" onClick={onClose}>Cancelar</button>
          </>
        )}
      </div>
    </div>
  );
}

function HowToPlay({ onClose }: { onClose: () => void }) {
  const steps = [
    ["🧳", "La máquina", "Al empezar cambia de cuerpo a algunos (Clásico: nadie sabe cuántos), a todos, o a todos menos al Inmutable."],
    ["❓", "La Pregunta", "Todos responden la misma pregunta… desde el cuerpo en el que están."],
    ["🦜", "El Hilo", "Cada respuesta sale publicada en Cotorra, la red social de la fiesta. Todos la comentan (❤️, 🤨, @etiquetas), una por una."],
    ["☀️", "Chat global", "Todos te ven con el nombre y avatar de tu cuerpo. Las respuestas quedan al lado."],
    ["🌙", "Chat privado", "Chats 1 a 1. Solo puedes INICIAR unos pocos (ojo al contador 💬); responder es gratis."],
    ["🧩", "¿Quién es quién?", "Clásico y Todos: +200 por descubrir qué mente hay en un cuerpo cambiado. +50 por acertar que alguien NO cambió."],
    ["🥷", "Sigilo / Despiste", "+150 si cambiaste y menos de la mitad te descubre. +150 si NO cambiaste pero la mitad cree que sí."],
    ["🎭", "El Desenmascare (opcional)", "Entre ciclos: si el 60% acierta qué mente hay en un cuerpo, esa mente queda fuera (−200) y quienes acertaron ganan +200."],
    ["🗿", "Modos Inmutables", "Uno nunca cambia de cuerpo. Los demás lo buscan y lo votan en 🗳️ La Votación (opcional) y en el ⚖️ Juicio Final, como en Among Us."],
    ["⏭", "Saltar", "Si todos ya terminaron, voten para saltar la fase."],
  ];
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h2>❓ Cómo se juega</h2>
        <ol className="how">
          {steps.map(([icon, title, text], i) => (
            <li key={title} className="pop-in" style={{ animationDelay: `${i * 0.06}s` }}>
              <span className="how-icon">{icon}</span>
              <div><b>{title}</b><p>{text}</p></div>
            </li>
          ))}
        </ol>
        <button className="btn big" onClick={() => { sfx.click(); onClose(); }}>¡Entendido!</button>
      </div>
    </div>
  );
}

function Floaties() {
  const items = ["🎭", "👻", "🔀", "🤫", "💬", "🕵️", "❓", "🌙", "☀️"];
  return (
    <div className="floaties" aria-hidden>
      {items.map((e, i) => <span key={i} style={{ left: `${(i * 11 + 4) % 100}%`, animationDelay: `${i * -2.3}s`, animationDuration: `${14 + (i % 4) * 3}s` }}>{e}</span>)}
    </div>
  );
}

// ======================= GAME =======================

function Game({ room }: { room: Room }) {
  const [s, setS] = useState<StateView | null>(null);
  const [me, setMe] = useState<Me | null>(null); // lo manda el server (puede no ser mi sessionId si retomé un lugar)
  const [role, setRole] = useState<Role>(null);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [dms, setDms] = useState<Record<string, DmMsg[]>>({});
  const [used, setUsed] = useState(0);
  const [graph, setGraph] = useState<ChatEdge[]>([]); // solo llega si soy espectador
  const [calls, setCalls] = useState<CallState>({ target: "", incoming: [], pairs: [] }); // 📻 Llamadas de radio
  const [myRatings, setMyRatings] = useState<Record<string, number>>({}); // 🎯 lo que califiqué (al reconectar)
  const [results, setResults] = useState<ResultsPayload | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [floats, setFloats] = useState<Floater[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [liked, setLiked] = useState<Set<string>>(new Set());
  const [sussed, setSussed] = useState<Set<string>>(new Set());
  // "Escribiendo…": clave "g:cuerpo" (día/hilo) o "d:cuerpo" (chat privado) -> hasta cuándo mostrarlo
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [seen, setSeen] = useState<Record<string, number>>({}); // chat privado: hasta qué mensaje mío leyó cada cuerpo
  const [toast, setToast] = useState<{ text: string; kind: string; id: number } | null>(null);
  const meRef = useRef(me);
  meRef.current = me;
  const voice = useVoice(room, s, me); // en el LOBBY y, si está activado, en el chat global y privado
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  function flash(text: string, kind = "info") {
    setToast({ text, kind, id: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }

  const toggleIn = (set: typeof setLiked, id: string) => set((prev) => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const social: Social = {
    liked, sussed,
    like: (id) => { sfx.pop(); toggleIn(setLiked, id); room.send("like", { id }); },
    sus: (id) => { sfx.click(); toggleIn(setSussed, id); room.send("sus", { id }); },
  };
  const stopTyping = (key: string) => setTyping((t) => { if (!(key in t)) return t; const n = { ...t }; delete n[key]; return n; });

  // El server decide dónde flota el emoji (sobre tu cuerpo al votar, sobre el expulsado en el anuncio).
  const react = (emoji: string) => { sfx.click(); room.send("react", { emoji }); };

  useEffect(() => {
    room.onStateChange((st: any) => setS(st.toJSON()));
    // El estado inicial puede haber llegado antes de montar este componente (onStateChange no lo repite).
    const syncNow = () => { if ((room.state as any)?.players?.size > 0) setS((prev) => prev ?? (room.state as any).toJSON()); };
    syncNow();
    const poll = setInterval(syncNow, 500);
    setTimeout(() => clearInterval(poll), 10000);
    room.onMessage("identity", ({ mindId, bodyId, role, spectator }: Me & { role: Role }) => { setMe({ mindId, bodyId, spectator: !!spectator }); setRole(role ?? null); });
    room.onMessage("chatHistory", setChat);
    room.onMessage("chat", (m: ChatMsg) => {
      setChat((c) => [...c, m]);
      stopTyping("g:" + m.fromBody);
      const mine = m.fromBody === (m.real ? meRef.current?.mindId : meRef.current?.bodyId);
      mine ? sfx.send() : sfx.pop();
    });
    room.onMessage("dmHistory", (list: DmMsg[]) => {
      const d: Record<string, DmMsg[]> = {};
      for (const m of list) (d[m.withBody] ??= []).push(m);
      setDms(d);
    });
    room.onMessage("dm", (m: DmMsg) => {
      setDms((d) => ({ ...d, [m.withBody]: [...(d[m.withBody] ?? []), m] }));
      stopTyping("d:" + m.fromBody);
      m.fromBody === meRef.current?.bodyId ? sfx.send() : sfx.pop();
    });
    room.onMessage("quota", ({ used }: { used: number }) => setUsed(used));
    room.onMessage("chatGraph", setGraph);
    room.onMessage("callState", setCalls);
    room.onMessage("callDeclined", ({ byBody }: { byBody: string }) => { sfx.fail(); flash(`📵 ${room.state.players.get(byBody)?.name ?? "Alguien"} rechazó tu llamada de radio`, "error"); });
    room.onMessage("myRatings", setMyRatings);
    room.onMessage("hostChanged", ({ id }: { id: string }) => { sfx.join(); flash(`👑 ${room.state.players.get(id)?.name ?? "Alguien"} ahora es el host`, "skip"); });
    room.onMessage("typing", ({ body, dm }: { body: string; dm?: boolean }) => {
      const key = (dm ? "d:" : "g:") + body;
      setTyping((t) => ({ ...t, [key]: Date.now() + 3000 }));
      setTimeout(() => setTyping((t) => {
        if (!(t[key] <= Date.now())) return t;
        const n = { ...t };
        delete n[key];
        return n;
      }), 3100);
    });
    room.onMessage("seen", ({ withBody, ts }: { withBody: string; ts: number }) => setSeen((v) => ({ ...v, [withBody]: Math.max(v[withBody] ?? 0, ts) })));
    room.onMessage("results", setResults);
    room.onMessage("verdict", setVerdict);
    room.onMessage("reaction", ({ target, emoji }: { target: string; emoji: string }) => {
      const id = Math.random();
      setFloats((f) => [...f.slice(-40), { id, target, emoji, x: 10 + Math.random() * 80 }]);
      setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1800);
    });
    room.onMessage("joined", () => sfx.join());
    room.onMessage("rejoined", ({ id }: { id: string }) => { sfx.join(); flash(`🔌 ${room.state.players.get(id)?.name ?? "Alguien"} se reconectó`, "skip"); });
    room.onMessage("skipped", ({ by }: { by: string }) => flash(by === "host" ? "⏩ El host saltó la fase" : "⏭ ¡Votaron saltar!", "skip"));
    room.onMessage("error", ({ message }) => { sfx.error(); flash(message, "error"); });
    room.send("whoami");
  }, [room]);

  // reseteos por fase
  const phaseKey = s ? `${s.phase}-${s.cycle}-${s.round}` : "";
  useEffect(() => {
    if (!s) return;
    if (s.phase === "NIGHT") { setDms({}); setUsed(0); setSeen({}); }
    if (s.phase === "EXACT") setMyRatings({});
    if (s.phase === "QUESTION") { setLiked(new Set()); setSussed(new Set()); }
    setTyping({});
    if (s.phase === "LOBBY") { setResults(null); setRevealed(false); }
    if (s.phase === "SWAP" && s.cycle === 0) setChat([]);
    if (s.phase !== "VERDICT") setVerdict(null);
  }, [phaseKey]);

  // 🎵 Música de la sala: solo en el lobby, la que eligió el host.
  const song = s?.phase === "LOBBY" ? s.settings.music : 0;
  useEffect(() => { setMusic(song); }, [song]);
  useEffect(() => () => setMusic(0), []);

  // tic-tac en los últimos segundos
  useEffect(() => {
    if (!s || !SKIPPABLE.includes(s.phase)) return;
    if (s.timer > 0 && s.timer <= 5) sfx.tickHot();
    else if (s.timer > 0 && s.timer <= 10) sfx.tick();
  }, [s?.timer]);

  if (!s || !me) return <div className="center"><div className="loader">🎭</div></div>;
  const players = Object.values(s.players);
  const isHost = s.hostId === me.mindId;
  const P: Lookup = (id) => s.players[id];
  const spectator = !!me.spectator;
  const typingIn = (prefix: string) => new Set(Object.keys(typing).filter((k) => k.startsWith(prefix)).map((k) => k.slice(2)));

  return (
    <div className={"game phase-" + s.phase}>
      {s.phase === "NIGHT" && <Stars n={60} />}
      <TopBar s={s} room={room} me={me} role={role} isHost={isHost} players={players} />
      <PhaseBanner s={s} bodyName={P(me.bodyId)?.name ?? "?"} />
      {toast && <div key={toast.id} className={"toast toast-" + toast.kind}>{toast.text}</div>}
      <main>
        {s.phase === "LOBBY" && (
          <div className="split">
            <Lobby s={s} players={players} isHost={isHost} room={room} voice={voice} />
            <GroupChat room={room} entries={chat} me={me} P={P} people={players} speakAs={P(me.mindId)?.name ?? ""} />
          </div>
        )}
        {s.phase === "SWAP" && (
          <SwapScreen key={s.cycle} players={players} mind={P(me.mindId)} body={P(me.bodyId)} spectator={!!me.spectator} timer={s.timer} role={role} reswap={s.cycle > 0} />
        )}
        {s.phase === "QUESTION" && <QuestionPhase room={room} s={s} me={me} P={P} players={players} />}
        {s.phase === "THREAD" && <ThreadPhase room={room} s={s} me={me} P={P} players={players} social={social} typing={typingIn("g:")} />}
        {s.phase === "DAY" && <DayView room={room} s={s} chat={chat} me={me} P={P} players={players} social={social} typing={typingIn("g:")} voice={voice} />}
        {(s.phase === "NIGHT" || s.phase === "RADIO") && (
          <PrivatePhase key={s.phase + s.cycle} room={room} s={s} players={players} me={me} dms={dms} used={used} P={P}
            typing={typingIn("d:")} seen={seen} graph={graph} voice={voice} calls={calls} />
        )}
        {["UNMASK", "VOTE", "FINAL_VOTE", "GUESS", "EXACT"].includes(s.phase) && (
          <WithPhaseChat room={room} s={s} chat={chat} me={me} P={P} players={players} typing={typingIn("g:")} voice={voice}>
            {s.phase === "GUESS" ? <Guess room={room} s={s} players={players} me={me} P={P} role={role} />
              : s.phase === "EXACT" ? <ExactPhase key={s.round} room={room} me={me} P={P} players={players} initial={myRatings} />
              : <VotePhase key={s.phase + s.cycle} room={room} s={s} me={me} role={role} P={P} players={players} floats={floats} react={react} />}
          </WithPhaseChat>
        )}
        {s.phase === "VERDICT" && <VerdictScreen v={verdict} P={P} me={me} floats={floats} react={react} />}
        {s.phase === "RESULTS" && (
          <>
            <Results data={results} P={P} me={me} isHost={isHost} room={room} onRevealed={setRevealed} />
            {revealed && results && <RoundDetailsView data={results} P={P} players={players} />}
            {revealed && <GroupChat className="results-chat" room={room} entries={chat} me={me} P={P} people={players} speakAs={P(me.mindId)?.name ?? ""} />}
          </>
        )}
        {spectator && ["DAY", "THREAD"].includes(s.phase) && <SpectatorNote />}
      </main>
    </div>
  );
}

/**
 * Votaciones, 🧩 y 🎯 con chat (si el host lo activó): la fase a la izquierda y el chat del cuerpo a la derecha;
 * arriba del chat, la tira de voz si también hay voz.
 */
function WithPhaseChat({ room, s, chat, me, P, players, typing, voice, children }: {
  room: Room; s: StateView; chat: ChatMsg[]; me: Me; P: Lookup; players: PlayerView[]; typing: Set<string>; voice: Voice; children: ReactNode;
}) {
  const ch = channels(s.settings, s.phase, s.sfu);
  if (!ch.text) return <>{children}</>;
  const people = players.filter((p) => !p.bodyOut);
  return (
    <div className="split vote-split">
      {children}
      <div className="chat-col">
        {ch.voice && voice.inGame && <VoiceStrip v={voice} people={people} me={me} P={P} />}
        <GroupChat room={room} entries={chat} me={me} P={P} people={people} speakAs={P(me.bodyId)?.name ?? ""}
          readOnly={!!me.spectator} heads={people} typing={typing} />
      </div>
    </div>
  );
}

function phaseLabel(s: StateView) {
  const cyc = s.totalCycles > 1 && s.cycle > 0 ? ` · ciclo ${s.cycle}/${s.totalCycles}` : "";
  switch (s.phase) {
    case "LOBBY": return "🛋️ Sala de espera";
    case "SWAP": return s.cycle > 0 ? `🧳 Re-cambio${cyc}` : "🧳 La máquina";
    case "QUESTION": return `❓ La Pregunta${cyc}`;
    case "THREAD": return `🦜 El Hilo ${s.thread + 1}/${s.posts.length}${cyc}`;
    case "DAY": return `☀️ Chat global${cyc}`;
    case "NIGHT": {
      const ch = channels(s.settings, "NIGHT", s.sfu);
      return !ch.text ? `📻 Llamada de radio${cyc}` : ch.voice ? `🌙 Chat privado + 📻 radio${cyc}` : `🌙 Chat privado${cyc}`;
    }
    case "RADIO": return `📻 Llamada de radio${cyc}`;
    case "EXACT": return "🎯 Exactitud";
    case "UNMASK": return `🎭 El Desenmascare${cyc}`;
    case "VOTE": return `🗳️ La Votación${cyc}`;
    case "VERDICT": return "⚖️ Resultado";
    case "GUESS": return "🧩 ¿Quién es quién?";
    case "FINAL_VOTE": return "⚖️ Juicio Final";
    default: return "🏆 Resultados";
  }
}

function TopBar({ s, room, me, role, isHost, players }: {
  s: StateView; room: Room; me: Me; role: Role; isHost: boolean; players: PlayerView[];
}) {
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  const [muted, setM] = useState(isMuted());
  const mind = s.players[me.mindId];
  const body = s.players[me.bodyId];
  const label = phaseLabel(s);
  const same = me.mindId === me.bodyId;
  const spectator = !!me.spectator;

  const voters = players.filter((p) => p.connected && !p.out);
  const votes = voters.filter((p) => p.skipVote).length;
  const needed = skipNeeded(Math.max(1, voters.length - ghostCount(players)));
  const myVote = mind?.skipVote;
  const canVote = SKIPPABLE.includes(s.phase) && !spectator;

  function copy() {
    navigator.clipboard?.writeText(`${location.origin}${location.pathname}?room=${room.roomId}`).catch(() => {});
    sfx.pop();
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  }

  let roleText: ReactNode;
  if (spectator) roleText = <span>👻 <b>Espectador</b> · eras {mind?.name}</span>;
  else if (role === "immutable") roleText = <span>🗿 <b>Eres el Inmutable</b> · sigues en tu cuerpo <em>— que no te descubran</em></span>;
  else if (role === "changer") roleText = <span>🔀 <b>Cambiante</b> · Mente: <b>{mind?.name}</b> · Cuerpo: <b>{body?.name}</b></span>;
  else if (same) roleText = <span>🟢 <b>No cambiaste</b> · sigues siendo <b>{mind?.name}</b>{s.phase !== "RESULTS" && <em> — ¿haces creer que sí? 😏</em>}</span>;
  else roleText = <span>Mente: <b>{mind?.name}</b> · Cuerpo: <b>{body?.name}</b>{s.phase !== "RESULTS" && <em> — actúa como {body?.name}</em>}</span>;

  return (
    <header className="top">
      <div className="top-left">
        <button className="chip" onClick={copy} title="Copiar link">🔗 {room.roomId} {copied && "¡copiado!"}</button>
        <b key={label} className="phase-label">{label}</b>
        {s.timer > 0 && <span key={s.timer} className={"timer" + (s.timer <= 10 ? " hot" : "")}>⏱ {s.timer}s</span>}
        {canVote && (
          <button className={"chip vote" + (myVote ? " on" : "")} onClick={() => { sfx.vote(); room.send("voteSkip"); }}
            title={`Se salta con ${needed} votos`}>
            ⏭ {myVote ? "Quitar voto" : s.phase === "THREAD" ? "Siguiente" : "Votar saltar"} <span className="votes">{votes}/{needed}</span>
          </button>
        )}
        {isHost && PLAYING.includes(s.phase) && (
          <button className="chip master" onClick={() => { sfx.whoosh(); room.send("skip"); }} title="Botón maestro del host">⏩ Forzar</button>
        )}
        <button className="chip" onClick={() => { setMuted(!muted); setM(!muted); if (muted) sfx.pop(); }} title="Sonido">{muted ? "🔇" : "🔊"}</button>
      </div>
      {!["LOBBY", "SWAP"].includes(s.phase) && body && mind && (
        <button className="secret" onClick={() => { sfx.click(); setHidden(!hidden); }}>
          {hidden ? "👁 Mostrar mi rol" : (
            <>
              <Avatar avatar={body.avatar} color={body.color} size={30} />
              {roleText}
            </>
          )}
        </button>
      )}
    </header>
  );
}

function Lobby({ s, players, isHost, room, voice }: { s: StateView; players: PlayerView[]; isHost: boolean; room: Room; voice: Voice }) {
  const enough = players.length >= s.minPlayers;
  const played = s.round > 0;
  const list = played ? [...players].sort((a, b) => b.score - a.score) : players;
  // 👑 Ceder el host: primer toque pide confirmar, el segundo lo pasa.
  const [giving, setGiving] = useState("");
  useEffect(() => {
    if (!giving) return;
    const t = setTimeout(() => setGiving(""), 3000);
    return () => clearTimeout(t);
  }, [giving]);
  function give(id: string) {
    sfx.click();
    if (giving !== id) return setGiving(id);
    setGiving("");
    room.send("giveHost", { to: id });
  }
  return (
    <div className="card lobby">
      {voice.showSetup && <VoiceSetup v={voice} />}
      <VoiceBar v={voice} P={(id) => s.players[id]} />
      <h2>{played ? `🏆 Marcador total · ${s.round} ronda${s.round === 1 ? "" : "s"}` : "Jugadores"} ({players.length}/{s.maxPlayers})</h2>
      <ul className="plist">
        {list.map((p, i) => (
          <li key={p.id} className="pop-in" style={{ animationDelay: `${i * 0.05}s` }}>
            {played && <span className="medal">{["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`}</span>}
            <span className={"voice-ring" + (voice.speaking[p.id] ? " speaking" : "")}>
              <Avatar avatar={p.avatar} color={p.color} size={42} className="bob" style={{ animationDelay: `${i * 0.3}s` }} />
            </span> {p.name}
            <span className="voice-icon" title="Voz">{voiceIcon(p)}</span>
            {p.id === s.hostId && <span className="tag">👑 HOST</span>}
            {isHost && p.id !== s.hostId && p.connected && (
              <button className={"chip give-host" + (giving === p.id ? " confirm" : "")} onClick={() => give(p.id)} title={`Pasarle el host a ${p.name}`}>
                {giving === p.id ? "✅ ¿Seguro?" : "👑 Ceder"}
              </button>
            )}
            {played && (
              <span className="score">
                {p.lastPoints !== 0 && <span className={"last" + (p.lastPoints < 0 ? " neg" : "")}>{p.lastPoints > 0 ? "+" : ""}{p.lastPoints}</span>} <b>{p.score}</b> pts
              </span>
            )}
          </li>
        ))}
        {Array.from({ length: Math.max(0, s.minPlayers - players.length) }, (_, i) => (
          <li key={"e" + i} className="empty">… esperando jugador</li>
        ))}
      </ul>
      <SettingsPanel s={s} isHost={isHost} room={room} players={players.length} />
      {isHost ? (
        <button className={"btn big" + (enough ? " wiggle" : "")} disabled={!enough} onClick={() => room.send("start")}>
          {enough ? "▶ EMPEZAR" : `Faltan ${s.minPlayers - players.length} (mín. ${s.minPlayers} en ${MODES[s.settings.mode].label})`}
        </button>
      ) : <p className="muted center-text">Esperando a que el host empiece…</p>}
      <p className="muted">Comparte el link (🔗 arriba) para invitar.</p>
    </div>
  );
}

function Toggle({ label, on, disabled, onChange, sub, hint }: {
  label: ReactNode; on: boolean; disabled?: boolean; onChange: (v: boolean) => void; sub?: boolean; hint?: ReactNode;
}) {
  return (
    <button type="button" className={"toggle" + (sub ? " sub" : "")} aria-pressed={on} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="box" /> <span>{label}{hint && <small className="toggle-hint">{hint}</small>}</span>
    </button>
  );
}

/** Varias opciones, una elegida (p. ej. qué chat privado hay de noche). */
function Segmented<T extends string | number>({ value, options, disabled, onChange, sub }: {
  value: T; options: [T, ReactNode][]; disabled?: boolean; onChange: (v: T) => void; sub?: boolean;
}) {
  return (
    <div className={"segmented" + (sub ? " sub" : "")}>
      {options.map(([v, label]) => (
        <button key={String(v)} type="button" className={v === value ? "on" : ""} disabled={disabled} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

type SetTab = "game" | "times" | "votes" | "voice" | "room";
type Row = { label: string; value: string; dec: () => void; inc: () => void };

/**
 * ⚙️ Configuración de la partida, en pestañas: 🎮 Partida · ⏱ Tiempos · 🗳️ Votaciones · 🎙️ Voz · 🎵 Sala.
 * Las opciones que dependen de otra aparecen debajo, con sangría, solo cuando esa otra está activa.
 * Abajo siempre queda el orden de la ronda y los avisos. Los demás la ven igual, sin poder tocarla.
 */
function SettingsPanel({ s, isHost, room, players }: { s: StateView; isHost: boolean; room: Room; players: number }) {
  const st = s.settings;
  const inm = isImmutableMode(st.mode);
  const [tab, setTab] = useState<SetTab>("game");
  const [warn, setWarn] = useState(false);
  const set = (patch: Partial<Settings>) => { sfx.click(); room.send("settings", patch); };
  const fmt = (sec: number) => (sec === 0 ? "Off" : sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")} min` : `${sec}s`);
  const time = (label: string, key: keyof Settings, step: number): Row => ({
    label, value: fmt(st[key] as number),
    dec: () => set({ [key]: (st[key] as number) - step }), inc: () => set({ [key]: (st[key] as number) + step }),
  });
  const cycles = st.cycles > 0 ? st.cycles : autoCycles(st.mode, players, st.earlyVote);
  const voteName = inm ? "🗳️ La Votación" : "🎭 El Desenmascare";
  const finalName = inm ? "⚖️ Juicio Final" : "🧩 ¿Quién es quién?";
  const voice = st.voicePhases && s.sfu;
  const radioPhase = hasRadioPhase(st, s.sfu);
  const night = channels(st, "NIGHT", s.sfu);
  const lock = !isHost;

  function toggleEarly(v: boolean) {
    if (v && players < 7) return setWarn(true);
    set({ earlyVote: v });
  }

  const row = (r: Row) => (
    <div key={r.label} className="set-row">
      <span>{r.label}</span>
      <div className="stepper">
        {isHost && <button onClick={r.dec}>−</button>}
        <b key={r.value} className="pop-in">{r.value}</b>
        {isHost && <button onClick={r.inc}>+</button>}
      </div>
    </div>
  );

  // Resumen de cada pestaña (se ve en la pestaña misma, así no hay que abrirlas todas para saber qué hay)
  const on = (b: boolean) => (b ? " •" : "");
  const tabs: [SetTab, string][] = [
    ["game", `${MODES[st.mode].icon} Modo`],
    ["times", "⏱ Tiempos"],
    ["votes", `🗳️ Votaciones${on(st.earlyVote || st.voteChat || st.exactPhase || (inm && st.immGuess))}`],
    ["voice", `🎙️ Voz${on(voice)}`],
    ["room", `🎵 Sala${on(st.music > 0)}`],
  ];

  let body: ReactNode;
  if (tab === "game") {
    body = (
      <>
        <ModePicker mode={st.mode} disabled={lock} onChange={(m) => set({ mode: m })} />
        {row({
          label: "🔁 Ciclos", value: st.cycles === 0 ? `Auto (${cycles})` : `${st.cycles}`,
          dec: () => set({ cycles: Math.max(0, st.cycles - 1) }), inc: () => set({ cycles: st.cycles + 1 }),
        })}
        {row({
          label: "💬 Chats por noche", value: st.chatsPerNight === 0 ? `Auto (${autoChats(players)})` : `${st.chatsPerNight}`,
          dec: () => set({ chatsPerNight: Math.max(0, st.chatsPerNight - 1) }), inc: () => set({ chatsPerNight: st.chatsPerNight + 1 }),
        })}
      </>
    );
  } else if (tab === "times") {
    body = (
      <>
        {[
          time("❓ La Pregunta", "questionSeconds", 15),
          time("🦜 El Hilo (c/ respuesta)", "threadSeconds", 5),
          time("☀️ Chat global", "daySeconds", 15),
          time(night.text ? "🌙 Chat privado" : "📻 Llamada de radio", "nightSeconds", 15),
          ...(radioPhase ? [time("📻 Llamada de radio", "radioSeconds", 15)] : []),
          ...(st.earlyVote ? [time(`⏱ ${voteName}`, "voteSeconds", 5)] : []),
          time(finalName, "guessSeconds", 15),
          ...(st.exactPhase ? [time("🎯 Exactitud", "exactSeconds", 5)] : []),
        ].map(row)}
        <p className="muted small">Pon una fase en <b>Off</b> para saltártela. {inm && st.immGuess && "🧩 ¿Quién es quién? usa el mismo tiempo que el Juicio Final."}</p>
      </>
    );
  } else if (tab === "votes") {
    body = (
      <div className="checks">
        <Toggle label={`${voteName} entre ciclos`} on={st.earlyVote} disabled={lock} onChange={toggleEarly} />
        {st.earlyVote && st.mode === "classic" && (
          <Toggle sub label="Se puede desenmascarar a quien no cambió" on={st.unmaskSame} disabled={lock} onChange={(v) => set({ unmaskSame: v })} />
        )}
        {st.earlyVote && row({
          label: "🚪 Máx. expulsiones", value: st.maxEjections === 0 ? "Sin límite" : `${st.maxEjections}`,
          dec: () => set({ maxEjections: Math.max(0, st.maxEjections - 1) }), inc: () => set({ maxEjections: st.maxEjections + 1 }),
        })}
        {inm && (
          <Toggle label="🧩 ¿Quién es quién? antes del Juicio Final" on={st.immGuess} disabled={lock} onChange={(v) => set({ immGuess: v })}
            hint="Adivinen qué mente hay en cada cuerpo: los cambiantes también tienen que cuidarse. Ideal en El No Cambiante." />
        )}
        <Toggle label="💬 Chat en las votaciones" on={st.voteChat} disabled={lock} onChange={(v) => set({ voteChat: v })}
          hint="Mientras votan, cada quien habla como su cuerpo." />
        {st.voteChat && (
          <Toggle sub label="🎙️ También por voz" on={st.voteVoice} disabled={lock || !voice} onChange={(v) => set({ voteVoice: v })}
            hint={!voice ? "Activa primero el chat de voz (pestaña 🎙️ Voz)." : "Sala de voz en las votaciones y en 🎯 Exactitud."} />
        )}
        <Toggle label="🎯 Exactitud (antes de los resultados)" on={st.exactPhase} disabled={lock} onChange={(v) => set({ exactPhase: v })}
          hint="Todos califican con ★ qué tan bien imitaron a cada cuerpo. Tu voto sobre tu cuerpo vale 2×; sobre los demás, 0,5×. Suma puntos al imitador." />
        {st.exactPhase && (
          <Toggle sub label="💬 Chat durante la Exactitud" on={st.exactChat} disabled={lock} onChange={(v) => set({ exactChat: v })}
            hint="Para discutir quién lo hizo bien o mal." />
        )}
      </div>
    );
  } else if (tab === "voice") {
    body = (
      <div className="checks">
        <Toggle label="🎙️ Chat de voz en la partida" on={st.voicePhases} disabled={lock || !s.sfu} onChange={(v) => set({ voicePhases: v })}
          hint={!s.sfu ? "Requiere el servidor de voz." : "Tu voz suena con la del dueño del cuerpo que ocupas."} />
        {st.voicePhases && (
          <>
            <Toggle sub label="💬🎙️ Chat de voz y texto a la vez" on={st.voiceText} disabled={lock} onChange={(v) => set({ voiceText: v })}
              hint="En el ☀️ chat global hay sala de voz y chat escrito juntos." />
            <div className="set-sub">
              <span className="set-sub-label">🌙 De noche, en privado:</span>
              <Segmented<NightMode> sub value={st.nightMode} disabled={lock} onChange={(v) => set({ nightMode: v })}
                options={[["radio", "📻 Llamada de radio"], ["chat", "💬 Chat privado"], ["both", "📻 + 💬 Ambas"]]} />
              <small className="toggle-hint">
                📻 La radio es en vivo: llamas, y el otro acepta o rechaza. 💬 El chat es asíncrono, con límite de chats por noche.
              </small>
            </div>
            {st.nightMode === "both" && (
              <Toggle sub label="✂️ Separar chats privados y Llamada de radio" on={st.splitRadio} disabled={lock} onChange={(v) => set({ splitRadio: v })}
                hint={st.splitRadio ? "Primero 🌙 chat privado y después su propia fase de 📻 Llamada de radio." : "Apagado: las dos a la vez, en pestañas."} />
            )}
          </>
        )}
        {row({
          label: "📻 Efecto walkie-talkie", value: WALKIE_LABELS[st.voiceWalkie] ?? "Off",
          dec: () => set({ voiceWalkie: Math.max(0, st.voiceWalkie - 1) }), inc: () => set({ voiceWalkie: Math.min(3, st.voiceWalkie + 1) }),
        })}
        <p className="muted small">Poquito: filtro de radio. Distorsión: además satura la voz. Radio: además estática, que suena solo mientras hablas.</p>
      </div>
    );
  } else {
    body = (
      <>
        <div className="set-sub">
          <span className="set-sub-label">🎵 Música de la sala de espera</span>
          <Segmented<number> value={st.music} disabled={lock} onChange={(v) => set({ music: v })}
            options={[[0, "🔇 Sin música"], ...SONGS.map((song, i) => [i + 1, `${song.icon} ${song.label}`] as [number, string])]} />
        </div>
        <p className="muted small">Suave y bajita, solo en la sala de espera. Cada quien la apaga con el 🔊 de arriba.</p>
      </>
    );
  }

  const perCycle = [
    st.questionSeconds > 0 && "❓",
    st.questionSeconds > 0 && st.threadSeconds > 0 && "🦜",
    st.daySeconds > 0 && "☀️",
    st.nightSeconds > 0 && (night.text ? (night.voice ? "🌙📻" : "🌙") : "📻"),
    radioPhase && st.radioSeconds > 0 && "📻",
  ].filter(Boolean).join(" → ");
  const between = [st.earlyVote && (inm ? "🗳️" : "🎭"), st.mode === "immutable" && "🧳"].filter(Boolean).join(" → ");
  const ending = [inm && st.immGuess && "🧩", finalName, st.exactPhase && "🎯 Exactitud"].filter(Boolean).join(" → ");
  const warnings: string[] = [];
  if (st.earlyVote && cycles < 2) warnings.push(`Con 1 ciclo no hay ${voteName}: al último ciclo le sigue ${finalName}.`);
  if (st.earlyVote && players < 7) warnings.push(`Con menos de 7 jugadores ${voteName} entre ciclos suele sacar a alguien muy pronto.`);
  if (st.mode === "immutable" && cycles > Math.max(1, players - 4)) {
    warnings.push(`Con ${players} jugadores y ${cycles} ciclos los cambiantes pueden deducir al Inmutable por eliminación.`);
  }

  return (
    <div className="settings">
      <h3>⚙️ Partida {isHost ? "" : <span className="muted">(la configura el host)</span>}</h3>
      <div className="tabs set-tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={"tab" + (tab === id ? " on" : "")} onClick={() => { sfx.click(); setTab(id); }}>{label}</button>
        ))}
      </div>
      <div className="set-body" key={tab}>{body}</div>
      {warnings.map((w) => <p key={w} className="set-warn">⚠️ {w}</p>)}
      <p className="muted small set-flow">
        Orden: 🧳 → {perCycle || between ? `(${[perCycle, between].filter(Boolean).join(" → ")})${cycles > 1 ? ` ×${cycles}` : ""} → ` : ""}{ending} → 🏆.
        {" "}La votación entre ciclos no ocurre en el último ciclo.
      </p>
      {warn && createPortal(
        <div className="modal-bg" onClick={() => setWarn(false)}>
          <div className="card modal rejoin" onClick={(e) => e.stopPropagation()}>
            <h2>⚠️ Pocos jugadores</h2>
            <p>Con menos de 7 jugadores, {voteName} entre ciclos suele sacar a alguien muy pronto y la partida pierde gracia. ¿Activarla igual?</p>
            <button className="btn big" onClick={() => { setWarn(false); set({ earlyVote: true }); }}>Activar igual</button>
            <button className="chip" onClick={() => { sfx.click(); setWarn(false); }}>Mejor no</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

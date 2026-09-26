import { useEffect, useMemo, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import confetti from "canvas-confetti";
import {
  client, saveReconnect, loadReconnect, clearReconnect, roomInfo, autoChats, skipNeeded,
  type StateView, type ChatMsg, type DmMsg, type RoundResult, type PlayerView, type Settings,
} from "./net";
import { Avatar, STYLES, STYLE_IDS, randomAvatar, randomSeed, type StyleId } from "./Avatar";
import { PhaseBanner, Stars, SwapScreen } from "./Overlay";
import { sfx, isMuted, setMuted } from "./sfx";

const COLORS = ["#ff4d8d", "#ff8a3d", "#ffd23d", "#5ee37a", "#3dd6ff", "#6c7bff", "#b36bff", "#ffffff"];
const codeFromUrl = () => new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
const load = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };

type Me = { mindId: string; bodyId: string };
type Lookup = (id: string) => PlayerView | undefined;

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
  const [color, setColor] = useState(() => load("lqha:color") ?? COLORS[Math.floor(Math.random() * COLORS.length)]);
  const [avatar, setAvatar] = useState(() => load("lqha:avatar") ?? randomAvatar());
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
    save("lqha:name", n); save("lqha:color", color); save("lqha:avatar", avatar);
    setErr(""); setBusy(true); sfx.boing();
    try {
      const opts = { name: n, color, avatar, takeover: !!takeoverAs };
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
  const reroll = () => { sfx.pop(); setAvatar(`${style}:${randomSeed()}`); setOptions(Array.from({ length: 5 }, randomSeed)); };

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
          <button className="dice" onClick={reroll} title="Otro avatar">🎲</button>
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
        <p className="credits">Avatares: <a href="https://www.dicebear.com" target="_blank" rel="noreferrer">DiceBear</a> · Fun Emoji (Davis Uche), Big Smile (Ashley Seo), Adventurer (Lisa Wischofsky), Croodles (vijay verma) — CC BY 4.0 · Bottts (Pablo Stanley)</p>
      </div>
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
    ["🔀", "La transferencia", "Al empezar, la máquina mete tu mente en el cuerpo de otro jugador. Te quedas ahí toda la partida."],
    ["☀️", "De día", "Chat grupal. Todos te ven con el nombre y avatar de tu cuerpo: actúa como esa persona… o delátate sin querer."],
    ["🌙", "De noche", "Chats privados 1 a 1. Solo puedes INICIAR unos pocos (ojo al contador 💬); responder es gratis."],
    ["🔍", "Adivina", "¿Qué mente hay en cada cuerpo? +200 por acierto."],
    ["🥷", "Sigilo", "+150 si menos de la mitad descubre quién eres."],
    ["⏭", "Saltar", "Si todos ya terminaron, voten para saltar la fase."],
  ];
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h2>❓ Cómo se juega</h2>
        <ol className="how">
          {steps.map(([icon, title, text], i) => (
            <li key={title} className="pop-in" style={{ animationDelay: `${i * 0.07}s` }}>
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
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [dms, setDms] = useState<Record<string, DmMsg[]>>({});
  const [used, setUsed] = useState(0);
  const [results, setResults] = useState<RoundResult[] | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: string; id: number } | null>(null);
  const meRef = useRef(me);
  meRef.current = me;
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  function flash(text: string, kind = "info") {
    setToast({ text, kind, id: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }

  useEffect(() => {
    room.onStateChange((st: any) => setS(st.toJSON()));
    // El estado inicial puede haber llegado antes de montar este componente (onStateChange no lo repite).
    const syncNow = () => { if ((room.state as any)?.players?.size > 0) setS((prev) => prev ?? (room.state as any).toJSON()); };
    syncNow();
    const poll = setInterval(syncNow, 500);
    setTimeout(() => clearInterval(poll), 10000);
    room.onMessage("identity", setMe);
    room.onMessage("chatHistory", setChat);
    room.onMessage("chat", (m: ChatMsg) => {
      setChat((c) => [...c, m]);
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
      m.fromBody === meRef.current?.bodyId ? sfx.send() : sfx.pop();
    });
    room.onMessage("quota", ({ used }: { used: number }) => setUsed(used));
    room.onMessage("results", setResults);
    room.onMessage("joined", () => sfx.join());
    room.onMessage("rejoined", ({ id }: { id: string }) => { sfx.join(); flash(`🔌 ${room.state.players.get(id)?.name ?? "Alguien"} se reconectó`, "skip"); });
    room.onMessage("skipped", ({ by }: { by: string }) => flash(by === "host" ? "⏩ El host saltó la fase" : "⏭ ¡Votaron saltar!", "skip"));
    room.onMessage("error", ({ message }) => { sfx.error(); flash(message, "error"); });
    room.send("whoami");
  }, [room]);

  // reseteos por fase
  const phaseKey = s ? `${s.phase}-${s.dayCount}-${s.round}` : "";
  useEffect(() => {
    if (!s) return;
    if (s.phase === "NIGHT") { setDms({}); setUsed(0); }
    if (s.phase === "LOBBY") setResults(null);
    if (s.phase === "SWAP") setChat([]);
  }, [phaseKey]);

  // tic-tac en los últimos segundos
  useEffect(() => {
    if (!s || !["DAY", "NIGHT", "GUESS"].includes(s.phase)) return;
    if (s.timer > 0 && s.timer <= 5) sfx.tickHot();
    else if (s.timer > 0 && s.timer <= 10) sfx.tick();
  }, [s?.timer]);

  if (!s || !me) return <div className="center"><div className="loader">🎭</div></div>;
  const players = Object.values(s.players);
  const isHost = s.hostId === me.mindId;
  const P: Lookup = (id) => s.players[id];

  return (
    <div className={"game phase-" + s.phase}>
      {s.phase === "NIGHT" && <Stars n={60} />}
      <TopBar s={s} room={room} me={me} isHost={isHost} players={players} />
      <PhaseBanner s={s} bodyName={P(me.bodyId)?.name ?? "?"} />
      {toast && <div key={toast.id} className={"toast toast-" + toast.kind}>{toast.text}</div>}
      <main>
        {s.phase === "LOBBY" && (
          <div className="split">
            <Lobby s={s} players={players} isHost={isHost} room={room} />
            <GroupChat room={room} entries={chat} me={me} P={P} speakAs={P(me.mindId)?.name ?? ""} />
          </div>
        )}
        {s.phase === "SWAP" && <SwapScreen players={players} mind={P(me.mindId)} body={P(me.bodyId)} timer={s.timer} />}
        {s.phase === "DAY" && <GroupChat room={room} entries={chat} me={me} P={P} speakAs={P(me.bodyId)?.name ?? ""} />}
        {s.phase === "NIGHT" && <Night room={room} s={s} players={players} me={me} dms={dms} used={used} P={P} />}
        {s.phase === "GUESS" && <Guess room={room} players={players} me={me} P={P} />}
        {s.phase === "RESULTS" && (
          <div className="split">
            <Results results={results} players={players} P={P} isHost={isHost} room={room} me={me} />
            <GroupChat room={room} entries={chat} me={me} P={P} speakAs={P(me.mindId)?.name ?? ""} />
          </div>
        )}
      </main>
    </div>
  );
}

function TopBar({ s, room, me, isHost, players }: { s: StateView; room: Room; me: Me; isHost: boolean; players: PlayerView[] }) {
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  const [muted, setM] = useState(isMuted());
  const mind = s.players[me.mindId];
  const body = s.players[me.bodyId];
  const label =
    s.phase === "LOBBY" ? "🛋️ Sala de espera" :
    s.phase === "SWAP" ? "🔀 Cambio de cuerpos" :
    s.phase === "DAY" ? `☀️ Día ${s.dayCount}/${s.settings.days}` :
    s.phase === "NIGHT" ? `🌙 Noche ${s.dayCount}` :
    s.phase === "GUESS" ? "🔍 ¿Quién es quién?" : "🏆 Resultados";

  const connected = players.filter((p) => p.connected);
  const votes = connected.filter((p) => p.skipVote).length;
  const needed = skipNeeded(connected.length);
  const myVote = s.players[me.mindId]?.skipVote;
  const canVote = ["DAY", "NIGHT", "GUESS"].includes(s.phase);

  function copy() {
    navigator.clipboard?.writeText(`${location.origin}${location.pathname}?room=${room.roomId}`);
    sfx.pop();
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  }

  return (
    <header className="top">
      <div className="top-left">
        <button className="chip" onClick={copy} title="Copiar link">🔗 {room.roomId} {copied && "¡copiado!"}</button>
        <b key={label} className="phase-label">{label}</b>
        {s.timer > 0 && <span key={s.timer} className={"timer" + (s.timer <= 10 ? " hot" : "")}>⏱ {s.timer}s</span>}
        {canVote && (
          <button className={"chip vote" + (myVote ? " on" : "")} onClick={() => { sfx.vote(); room.send("voteSkip"); }}
            title={`Se salta con ${needed} votos`}>
            ⏭ {myVote ? "Quitar voto" : "Votar saltar"} <span className="votes">{votes}/{needed}</span>
          </button>
        )}
        {isHost && ["SWAP", "DAY", "NIGHT", "GUESS"].includes(s.phase) && (
          <button className="chip master" onClick={() => { sfx.whoosh(); room.send("skip"); }} title="Botón maestro del host">⏩ Forzar</button>
        )}
        <button className="chip" onClick={() => { setMuted(!muted); setM(!muted); if (muted) sfx.pop(); }} title="Sonido">{muted ? "🔇" : "🔊"}</button>
      </div>
      {!["LOBBY", "SWAP"].includes(s.phase) && body && mind && (
        <button className="secret" onClick={() => { sfx.click(); setHidden(!hidden); }}>
          {hidden ? "👁 Mostrar mi rol" : (
            <>
              <Avatar avatar={body.avatar} color={body.color} size={30} />
              <span>Mente: <b>{mind.name}</b> · Cuerpo: <b>{body.name}</b>
                {s.phase !== "RESULTS" && <em> — actúa como {body.name}</em>}</span>
            </>
          )}
        </button>
      )}
    </header>
  );
}

function Lobby({ s, players, isHost, room }: { s: StateView; players: PlayerView[]; isHost: boolean; room: Room }) {
  const enough = players.length >= s.minPlayers;
  return (
    <div className="card lobby">
      <h2>Jugadores ({players.length}/8)</h2>
      <ul className="plist">
        {players.map((p, i) => (
          <li key={p.id} className="pop-in" style={{ animationDelay: `${i * 0.05}s` }}>
            <Avatar avatar={p.avatar} color={p.color} size={42} className="bob" style={{ animationDelay: `${i * 0.3}s` }} /> {p.name}
            {p.id === s.hostId && <span className="tag">👑 HOST</span>}
            {s.round > 0 && <span className="score">{p.score} pts</span>}
          </li>
        ))}
        {Array.from({ length: Math.max(0, s.minPlayers - players.length) }, (_, i) => (
          <li key={"e" + i} className="empty">… esperando jugador</li>
        ))}
      </ul>
      <SettingsPanel s={s} isHost={isHost} room={room} players={players.length} />
      {isHost ? (
        <button className={"btn big" + (enough ? " wiggle" : "")} disabled={!enough} onClick={() => room.send("start")}>
          {enough ? "▶ EMPEZAR" : `Faltan ${s.minPlayers - players.length}`}
        </button>
      ) : <p className="muted center-text">Esperando a que el host empiece…</p>}
      <p className="muted">Comparte el link (🔗 arriba) para invitar. Mínimo {s.minPlayers} jugadores.</p>
    </div>
  );
}

function SettingsPanel({ s, isHost, room, players }: { s: StateView; isHost: boolean; room: Room; players: number }) {
  const st = s.settings;
  const set = (patch: Partial<Settings>) => { sfx.click(); room.send("settings", patch); };
  const fmt = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")} min` : `${sec}s`);
  const rows: { label: string; value: string; dec: () => void; inc: () => void }[] = [
    { label: "☀️ Días", value: `${st.days}`, dec: () => set({ days: st.days - 1 }), inc: () => set({ days: st.days + 1 }) },
    { label: "🌙 Noches", value: `${st.nights}`, dec: () => set({ nights: st.nights - 1 }), inc: () => set({ nights: st.nights + 1 }) },
    { label: "⏱ Duración día", value: fmt(st.daySeconds), dec: () => set({ daySeconds: st.daySeconds - 15 }), inc: () => set({ daySeconds: st.daySeconds + 15 }) },
    { label: "⏱ Duración noche", value: fmt(st.nightSeconds), dec: () => set({ nightSeconds: st.nightSeconds - 15 }), inc: () => set({ nightSeconds: st.nightSeconds + 15 }) },
    { label: "⏱ Adivinanza", value: fmt(st.guessSeconds), dec: () => set({ guessSeconds: st.guessSeconds - 15 }), inc: () => set({ guessSeconds: st.guessSeconds + 15 }) },
    {
      label: "💬 Chats por noche",
      value: st.chatsPerNight === 0 ? `Auto (${autoChats(players)})` : `${st.chatsPerNight}`,
      dec: () => set({ chatsPerNight: Math.max(0, st.chatsPerNight - 1) }),
      inc: () => set({ chatsPerNight: st.chatsPerNight + 1 }),
    },
  ];
  return (
    <div className="settings">
      <h3>⚙️ Partida {isHost ? "" : <span className="muted">(la configura el host)</span>}</h3>
      {rows.map((r) => (
        <div key={r.label} className="set-row">
          <span>{r.label}</span>
          <div className="stepper">
            {isHost && <button onClick={r.dec}>−</button>}
            <b key={r.value} className="pop-in">{r.value}</b>
            {isHost && <button onClick={r.inc}>+</button>}
          </div>
        </div>
      ))}
      <p className="muted small">
        {st.days} día{st.days === 1 ? "" : "s"} y {st.nights} noche{st.nights === 1 ? "" : "s"}. El cambio de cuerpos ocurre UNA vez, antes del Día 1.
        Auto: 2 chats (≤5 jugadores), 3 (6–7), 4 (8).
      </p>
    </div>
  );
}

function GroupChat({ room, entries, me, P, speakAs }: { room: Room; entries: ChatMsg[]; me: Me; P: Lookup; speakAs: string }) {
  return (
    <div className="card chat">
      <Messages
        items={entries.map((m) => ({ ...m, mine: m.fromBody === (m.real ? me.mindId : me.bodyId) }))}
        P={P}
      />
      <Composer onSend={(text) => room.send("chat", { text })} placeholder={`Escribe como ${speakAs}…`} />
    </div>
  );
}

type Item = { fromBody: string; text: string; ts: number; mine: boolean; tag?: string };

function Messages({ items, P, empty = "Nadie ha dicho nada aún… 🦗" }: { items: Item[]; P: Lookup; empty?: string }) {
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

function Composer({ onSend, placeholder, disabled }: { onSend: (t: string) => void; placeholder: string; disabled?: boolean }) {
  const [t, setT] = useState("");
  const send = () => { if (t.trim()) { onSend(t.trim()); setT(""); } };
  return (
    <div className="composer">
      <input value={t} maxLength={300} disabled={disabled} placeholder={placeholder} onChange={(e) => setT(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
      <button className="btn" disabled={disabled} onClick={send}>Enviar</button>
    </div>
  );
}

function Night({ room, s, players, me, dms, used, P }: {
  room: Room; s: StateView; players: PlayerView[]; me: Me; dms: Record<string, DmMsg[]>; used: number; P: Lookup;
}) {
  const others = players.filter((p) => p.id !== me.bodyId);
  const [sel, setSel] = useState<string>("");
  const active = sel || Object.keys(dms)[0] || "";
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
            {hasConvo(p.id) && <span className="dot">{dms[p.id].length}</span>}
          </button>
        ))}
      </div>
      <div className="card chat">
        {active ? (
          <>
            <div className="chat-head">🌙 Privado con el cuerpo de <b>{P(active)?.name}</b></div>
            <Messages items={(dms[active] ?? []).map((m) => ({ ...m, mine: m.fromBody === me.bodyId }))} P={P}
              empty={locked(active) ? "🔒 Ya usaste todos tus chats de esta noche." : `Escribir aquí usa 1 de tus ${left} chat${left === 1 ? "" : "s"} disponibles.`} />
            <Composer disabled={locked(active)} onSend={(text) => room.send("dm", { toBody: active, text })}
              placeholder={locked(active) ? "Sin chats disponibles 🔒" : `Escribe como ${P(me.bodyId)?.name}…`} />
          </>
        ) : <div className="muted center-text night-empty">🌙<br />Elige un cuerpo para hablar en privado… o quédate callado 🤫</div>}
      </div>
    </div>
  );
}

function Guess({ room, players, me, P }: { room: Room; players: PlayerView[]; me: Me; P: Lookup }) {
  const bodies = players.filter((p) => p.id !== me.bodyId);
  const minds = players.filter((p) => p.id !== me.mindId);
  const [g, setG] = useState<Record<string, string>>({});
  const submitted = P(me.mindId)?.submitted;
  const done = players.filter((p) => p.submitted).length;
  const used = new Set(Object.values(g));
  const complete = bodies.every((b) => g[b.id]);

  function pick(body: string, mind: string) {
    if (submitted) return;
    sfx.pop();
    setG((prev) => ({ ...prev, [body]: prev[body] === mind ? "" : mind }));
  }

  return (
    <div className="card guess">
      <h2>¿Qué mente está en cada cuerpo?</h2>
      <p className="muted">+200 por cada acierto · +150 si menos de la mitad te descubre. Tú estás en el cuerpo de <b>{P(me.bodyId)?.name}</b>.</p>
      <div className="grid">
        {bodies.map((b, i) => {
          const m = g[b.id] ? P(g[b.id]) : undefined;
          return (
            <div key={b.id} className={"gcard pop-in" + (m ? " filled" : "")} style={{ animationDelay: `${i * 0.06}s` }}>
              <div className="gbody">
                <Avatar avatar={b.avatar} color={b.color} size={64} />
                <div className="gname">Cuerpo de {b.name}</div>
              </div>
              <div className="gmind">{m ? <>🧠 <b>{m.name}</b></> : "🧠 ¿…?"}</div>
              <div className="mind-chips">
                {minds.map((mm) => (
                  <button key={mm.id} disabled={submitted}
                    className={"mchip" + (g[b.id] === mm.id ? " on" : "") + (used.has(mm.id) && g[b.id] !== mm.id ? " used" : "")}
                    onClick={() => pick(b.id, mm.id)}>
                    {mm.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {submitted ? <p className="muted center-text">✅ Enviado. Esperando al resto ({done}/{players.length})…</p> : (
        <button className={"btn big" + (complete ? " wiggle" : "")} onClick={() => { sfx.boing(); room.send("guesses", { guesses: g }); }}>
          ENVIAR {complete ? "🚀" : `(${Object.values(g).filter(Boolean).length}/${bodies.length})`}
        </button>
      )}
    </div>
  );
}

function Results({ results, players, P, isHost, room, me }: {
  results: RoundResult[] | null; players: PlayerView[]; P: Lookup; isHost: boolean; room: Room; me: Me;
}) {
  const ranking = useMemo(() => [...players].sort((a, b) => b.score - a.score), [players]);
  const [shown, setShown] = useState(0);
  const total = results?.length ?? 0;

  // Revelación una por una con redoble
  useEffect(() => {
    if (!results || shown >= total) return;
    const t = setTimeout(() => {
      sfx.reveal();
      setShown((n) => n + 1);
    }, shown === 0 ? 2200 : 1500);
    if (shown > 0) setTimeout(() => sfx.drumroll(0.9), 400);
    return () => clearTimeout(t);
  }, [results, shown]);

  useEffect(() => {
    if (!results || shown !== total || total === 0) return;
    sfx.win();
    const end = Date.now() + 1500;
    const burst = () => {
      confetti({ particleCount: 40, angle: 60, spread: 60, origin: { x: 0 } });
      confetti({ particleCount: 40, angle: 120, spread: 60, origin: { x: 1 } });
      if (Date.now() < end) setTimeout(burst, 250);
    };
    burst();
  }, [shown === total && total > 0]);

  if (!results) return <div className="card"><div className="loader">🥁</div></div>;
  const allShown = shown >= total;
  return (
    <div className="card results">
      <h2>Quién era quién</h2>
      <div className="reveal">
        {results.map((r, i) => {
          const body = P(r.bodyId);
          const mind = P(r.mindId);
          const open = i < shown;
          return (
            <div key={r.mindId} className={"rrow" + (open ? " open" : "") + (r.mindId === me.mindId ? " me" : "")}>
              <div className="rbody">
                <Avatar avatar={body?.avatar} color={body?.color ?? "#999"} size={44} />
                <span>Cuerpo de <b>{body?.name}</b></span>
              </div>
              <span className="arrow">era</span>
              <div className="flip">
                <div className="flip-inner">
                  <div className="flip-front">❓</div>
                  <div className="flip-back">
                    <Avatar avatar={mind?.avatar} color={mind?.color ?? "#999"} size={32} />
                    <b className="rmind">{mind?.name}</b>
                  </div>
                </div>
              </div>
              {open && (
                <div className="rstats">
                  <span>🎯 {r.correct} aciertos</span>
                  <span>{r.stealth ? "🥷 +150 sigilo" : `👀 descubierto por ${r.guessedBy}`}</span>
                  {total > 2 && r.correct === total - 1 && <span className="badge">🏅 ¡Sabías lo que había adentro!</span>}
                  <b className="pts">+{r.points}</b>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!allShown && <button className="chip" onClick={() => setShown(total)}>Revelar todo ⏩</button>}
      {allShown && (
        <>
          <h3>Marcador</h3>
          <ol className="rank">
            {ranking.map((p, i) => (
              <li key={p.id} className="pop-in" style={{ animationDelay: `${i * 0.12}s` }}>
                <span className="medal">{["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`}</span>
                <Avatar avatar={p.avatar} color={p.color} size={30} /> {p.name} <b>{p.score}</b>
              </li>
            ))}
          </ol>
          {isHost ? <button className="btn big wiggle" onClick={() => room.send("next")}>▶ SIGUIENTE RONDA</button>
            : <p className="muted center-text">Esperando al host…</p>}
        </>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import {
  client, saveReconnect, loadReconnect, clearReconnect, roomInfo,
  type StateView, type ChatMsg, type DmMsg, type RoundResult, type PlayerView,
} from "./net";

const COLORS = ["#ff4d8d", "#ff8a3d", "#ffd23d", "#5ee37a", "#3dd6ff", "#6c7bff", "#b36bff", "#ffffff"];
const codeFromUrl = () => new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";

export default function App() {
  const [room, setRoom] = useState<Room | null>(null);
  const [booting, setBooting] = useState(true);

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
    r.onLeave(() => {
      clearReconnect();
      setRoom(null);
    });
    setRoom(r);
  }

  if (booting) return <div className="center">Cargando…</div>;
  return room ? <Game room={room} /> : <Home onRoom={onRoom} />;
}

// ======================= HOME =======================

function Home({ onRoom }: { onRoom: (r: Room) => void }) {
  const [name, setName] = useState(() => localStorage.getItem("lqha:name") ?? "");
  const [color, setColor] = useState(() => localStorage.getItem("lqha:color") ?? COLORS[Math.floor(Math.random() * COLORS.length)]);
  const [code, setCode] = useState(codeFromUrl());
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const linked = codeFromUrl();

  async function go(kind: "create" | "join") {
    if (!name.trim()) return setErr("Pon tu username");
    try { localStorage.setItem("lqha:name", name.trim()); localStorage.setItem("lqha:color", color); } catch {}
    setErr(""); setBusy(true);
    try {
      const opts = { name: name.trim(), color };
      if (kind === "create") onRoom(await client.create("game", opts));
      else {
        const c = code.trim().toUpperCase();
        const info = await roomInfo(c);
        if (!info.exists) throw new Error("Esa sala no existe");
        if (info.locked) throw new Error("La sala ya está en partida o llena");
        onRoom(await client.joinById(c, opts));
      }
    } catch (e: any) {
      setErr(e?.message ?? "Error");
    } finally { setBusy(false); }
  }

  return (
    <div className="center">
      <div className="card home">
        <h1 className="logo">LO QUE HAY<br />ADENTRO</h1>
        <p className="sub">Cambia de cuerpo. Descubre quién es quién.</p>
        <Avatar color={color} name={name || "?"} size={88} />
        <label>Pon tu username y escoge un color</label>
        <input value={name} maxLength={16} placeholder="Tu nombre" onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go(linked ? "join" : "create")} />
        <div className="swatches">
          {COLORS.map((c) => (
            <button key={c} className={"swatch" + (c === color ? " on" : "")} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
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
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  );
}

// ======================= GAME =======================

type Entry = (ChatMsg & { mine?: boolean }) | { system: string };

function Game({ room }: { room: Room }) {
  const [s, setS] = useState<StateView | null>(null);
  const [me, setMe] = useState<{ mindId: string; bodyId: string }>({ mindId: room.sessionId, bodyId: room.sessionId });
  const [chat, setChat] = useState<Entry[]>([]);
  const [dms, setDms] = useState<Record<string, Entry[]>>({});
  const [results, setResults] = useState<RoundResult[] | null>(null);
  const [toast, setToast] = useState("");
  const bodyRef = useRef(room.sessionId); // cuerpo en el momento de recibir (para alinear "mis" mensajes)
  bodyRef.current = me.bodyId;

  useEffect(() => {
    room.onStateChange((st: any) => setS(st.toJSON()));
    room.onMessage("identity", setMe);
    room.onMessage("chat", (m: ChatMsg) => setChat((c) => [...c, { ...m, mine: m.fromBody === bodyRef.current }]));
    room.onMessage("dm", (m: DmMsg) => setDms((d) => ({ ...d, [m.withBody]: [...(d[m.withBody] ?? []), { ...m, mine: m.fromBody === bodyRef.current }] })));
    room.onMessage("results", setResults);
    room.onMessage("error", ({ message }) => { setToast(message); setTimeout(() => setToast(""), 3000); });
    room.send("whoami");
  }, [room]);

  // separadores y reseteos por fase
  const phaseKey = s ? `${s.phase}-${s.dayCount}-${s.round}` : "";
  useEffect(() => {
    if (!s) return;
    if (s.phase === "DAY") setChat((c) => [...c, { system: `☀️ Día ${s.dayCount}` }]);
    if (s.phase === "NIGHT") setDms({});
    if (s.phase === "LOBBY") { setResults(null); }
    if (s.phase === "DAY" && s.dayCount === 1) setChat([{ system: `☀️ Ronda ${s.round} · Día 1` }]);
  }, [phaseKey]);

  if (!s) return <div className="center">Conectando…</div>;
  const players = Object.values(s.players);
  const isHost = s.hostId === room.sessionId;
  const P = (id: string) => s.players[id];

  return (
    <div className={"game phase-" + s.phase}>
      <TopBar s={s} room={room} me={me} isHost={isHost} />
      {toast && <div className="toast">{toast}</div>}
      <main>
        {s.phase === "LOBBY" && (
          <div className="split">
            <Lobby s={s} players={players} isHost={isHost} room={room} />
            <GroupChat room={room} entries={chat} myBody={me.bodyId} P={P} enabled />
          </div>
        )}
        {s.phase === "DAY" && <GroupChat room={room} entries={chat} myBody={me.bodyId} P={P} enabled />}
        {s.phase === "NIGHT" && <Night room={room} players={players} myBody={me.bodyId} dms={dms} P={P} />}
        {s.phase === "GUESS" && <Guess room={room} players={players} me={me} P={P} />}
        {s.phase === "RESULTS" && (
          <div className="split">
            <Results results={results} players={players} P={P} isHost={isHost} room={room} />
            <GroupChat room={room} entries={chat} myBody={me.bodyId} P={P} enabled />
          </div>
        )}
      </main>
    </div>
  );
}

function TopBar({ s, room, me, isHost }: { s: StateView; room: Room; me: { mindId: string; bodyId: string }; isHost: boolean }) {
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  const mind = s.players[me.mindId]?.name ?? "?";
  const body = s.players[me.bodyId];
  const label =
    s.phase === "LOBBY" ? "Sala de espera" :
    s.phase === "DAY" ? `☀️ Día ${s.dayCount}` :
    s.phase === "NIGHT" ? `🌙 Noche ${s.dayCount}` :
    s.phase === "GUESS" ? "🔍 ¿Quién es quién?" : "🏆 Resultados";

  function copy() {
    navigator.clipboard?.writeText(`${location.origin}${location.pathname}?room=${room.roomId}`);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  }

  return (
    <header className="top">
      <div className="top-left">
        <button className="chip" onClick={copy} title="Copiar link">🔗 {room.roomId} {copied && "¡copiado!"}</button>
        <b>{label}</b>
        {s.timer > 0 && <span className={"timer" + (s.timer <= 10 ? " hot" : "")}>{s.timer}s</span>}
        {isHost && ["DAY", "NIGHT", "GUESS"].includes(s.phase) && (
          <button className="chip" onClick={() => room.send("skip")}>Saltar ⏭</button>
        )}
      </div>
      {s.phase !== "LOBBY" && body && (
        <button className="secret" onClick={() => setHidden(!hidden)}>
          {hidden ? "👁 Mostrar mi rol" : (
            <>
              <Avatar color={body.color} name={body.name} size={28} />
              <span>Tu mente: <b>{mind}</b> · Cuerpo actual: <b>{body.name}</b>
                {me.mindId !== me.bodyId && <em> — disimula y actúa como {body.name}</em>}</span>
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
    <div className="card">
      <h2>Jugadores ({players.length}/8)</h2>
      <ul className="plist">
        {players.map((p) => (
          <li key={p.id}>
            <Avatar color={p.color} name={p.name} size={36} /> {p.name}
            {p.id === s.hostId && <span className="tag">HOST</span>}
            {s.round > 0 && <span className="score">{p.score} pts</span>}
          </li>
        ))}
      </ul>
      <p className="muted">Comparte el link para invitar. Mínimo {s.minPlayers} jugadores.</p>
      {isHost ? (
        <button className="btn big" disabled={!enough} onClick={() => room.send("start")}>
          {enough ? "▶ EMPEZAR" : `Faltan ${s.minPlayers - players.length}`}
        </button>
      ) : <p className="muted">Esperando a que el host empiece…</p>}
    </div>
  );
}

function GroupChat({ room, entries, myBody, P, enabled }: {
  room: Room; entries: Entry[]; myBody: string; P: (id: string) => PlayerView | undefined; enabled: boolean;
}) {
  return (
    <div className="card chat">
      <Messages entries={entries} myBody={myBody} P={P} />
      {enabled && <Composer onSend={(text) => room.send("chat", { text })} placeholder={`Escribe como ${P(myBody)?.name ?? ""}…`} />}
    </div>
  );
}

function Messages({ entries, myBody, P }: { entries: Entry[]; myBody: string; P: (id: string) => PlayerView | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [entries.length]);
  return (
    <div className="msgs" ref={ref}>
      {entries.length === 0 && <div className="muted center-text">Nadie ha dicho nada aún…</div>}
      {entries.map((m, i) =>
        "system" in m ? <div key={i} className="sys">{m.system}</div> : (
          <div key={i} className={"msg" + ((m.mine ?? m.fromBody === myBody) ? " mine" : "")}>
            <Avatar color={P(m.fromBody)?.color ?? "#999"} name={P(m.fromBody)?.name ?? "?"} size={30} />
            <div className="bubble">
              <div className="who" style={{ color: P(m.fromBody)?.color }}>{P(m.fromBody)?.name ?? "?"}</div>
              {m.text}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function Composer({ onSend, placeholder }: { onSend: (t: string) => void; placeholder: string }) {
  const [t, setT] = useState("");
  const send = () => { if (t.trim()) { onSend(t.trim()); setT(""); } };
  return (
    <div className="composer">
      <input value={t} maxLength={300} placeholder={placeholder} onChange={(e) => setT(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
      <button className="btn" onClick={send}>Enviar</button>
    </div>
  );
}

function Night({ room, players, myBody, dms, P }: {
  room: Room; players: PlayerView[]; myBody: string; dms: Record<string, Entry[]>; P: (id: string) => PlayerView | undefined;
}) {
  const others = players.filter((p) => p.id !== myBody);
  const [sel, setSel] = useState<string>("");
  const open = Object.keys(dms);
  const active = sel || open[0] || "";
  return (
    <div className="night">
      <div className="card tabs">
        <h3>Chats privados</h3>
        <p className="muted">Máx. 2 cuerpos por noche. Estás en el cuerpo de <b>{P(myBody)?.name}</b>.</p>
        {others.map((p) => (
          <button key={p.id} className={"tab" + (active === p.id ? " on" : "")} onClick={() => setSel(p.id)}>
            <Avatar color={p.color} name={p.name} size={28} /> {p.name}
            {dms[p.id] && <span className="dot">{dms[p.id].length}</span>}
          </button>
        ))}
      </div>
      <div className="card chat">
        {active ? (
          <>
            <div className="chat-head">🌙 Privado con el cuerpo de <b>{P(active)?.name}</b></div>
            <Messages entries={dms[active] ?? []} myBody={myBody} P={P} />
            <Composer onSend={(text) => room.send("dm", { toBody: active, text })} placeholder={`Escribe como ${P(myBody)?.name}…`} />
          </>
        ) : <div className="muted center-text">Elige un cuerpo para hablar en privado… o quédate callado 🤫</div>}
      </div>
    </div>
  );
}

function Guess({ room, players, me, P }: {
  room: Room; players: PlayerView[]; me: { mindId: string; bodyId: string }; P: (id: string) => PlayerView | undefined;
}) {
  const bodies = players.filter((p) => p.id !== me.bodyId);
  const minds = players.filter((p) => p.id !== me.mindId);
  const [g, setG] = useState<Record<string, string>>({});
  const submitted = P(me.mindId)?.submitted;
  const done = players.filter((p) => p.submitted).length;
  const used = new Set(Object.values(g));
  return (
    <div className="card guess">
      <h2>¿Qué mente está en cada cuerpo?</h2>
      <p className="muted">+200 por cada acierto. Tú estás en el cuerpo de <b>{P(me.bodyId)?.name}</b>.</p>
      <div className="grid">
        {bodies.map((b) => (
          <div key={b.id} className="gcard">
            <Avatar color={b.color} name={b.name} size={56} />
            <div className="gname">Cuerpo de {b.name}</div>
            <select disabled={submitted} value={g[b.id] ?? ""} onChange={(e) => setG({ ...g, [b.id]: e.target.value })}>
              <option value="">— mente —</option>
              {minds.map((m) => (
                <option key={m.id} value={m.id}>{m.name}{used.has(m.id) && g[b.id] !== m.id ? " (ya usada)" : ""}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
      {submitted ? <p className="muted">✅ Enviado. Esperando al resto ({done}/{players.length})…</p> : (
        <button className="btn big" onClick={() => room.send("guesses", { guesses: g })}>ENVIAR</button>
      )}
    </div>
  );
}

function Results({ results, players, P, isHost, room }: {
  results: RoundResult[] | null; players: PlayerView[]; P: (id: string) => PlayerView | undefined; isHost: boolean; room: Room;
}) {
  const ranking = useMemo(() => [...players].sort((a, b) => b.score - a.score), [players]);
  if (!results) return <div className="card">Calculando…</div>;
  return (
    <div className="card">
      <h2>Quién era quién</h2>
      <div className="reveal">
        {results.map((r, i) => (
          <div key={r.mindId} className="rrow" style={{ animationDelay: `${i * 0.25}s` }}>
            <div className="rbody">
              <Avatar color={P(r.finalBodyId)?.color ?? "#999"} name={P(r.finalBodyId)?.name ?? "?"} size={40} />
              <span>Cuerpo de <b>{P(r.finalBodyId)?.name}</b></span>
            </div>
            <span className="arrow">era</span>
            <b className="rmind">{P(r.mindId)?.name}</b>
            <div className="rstats">
              <span>{r.correct} aciertos</span>
              <span>{r.stealth ? "🥷 +150 sigilo" : `descubierto por ${r.guessedBy}`}</span>
              <b>+{r.points}</b>
            </div>
            <div className="hist">Recorrido: {r.history.map((h) => P(h)?.name ?? "?").join(" → ")}</div>
          </div>
        ))}
      </div>
      <h3>Marcador</h3>
      <ol className="rank">
        {ranking.map((p) => <li key={p.id}><Avatar color={p.color} name={p.name} size={24} /> {p.name} <b>{p.score}</b></li>)}
      </ol>
      {isHost ? <button className="btn big" onClick={() => room.send("next")}>▶ SIGUIENTE RONDA</button>
        : <p className="muted">Esperando al host…</p>}
    </div>
  );
}

function Avatar({ color, name, size }: { color: string; name: string; size: number }) {
  return (
    <span className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.45 }}>
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

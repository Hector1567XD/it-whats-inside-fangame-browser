import { Room, Client, ServerError, type Deferred } from "@colyseus/core";
import { GameState, Player, Settings } from "./GameState.js";

const num = (v: string | undefined, d: number) => (v && !isNaN(+v) ? +v : d);
const DAY_SECONDS = num(process.env.DAY_SECONDS, 120);
const NIGHT_SECONDS = num(process.env.NIGHT_SECONDS, 90);
const GUESS_SECONDS = num(process.env.GUESS_SECONDS, 90);
const SWAP_SECONDS = num(process.env.SWAP_SECONDS, 10); // animación de cambio de cuerpos antes del Día 1
const MIN_PLAYERS = num(process.env.MIN_PLAYERS, 4);
const MAX_PLAYERS = 8;
const MAX_CHAT_LOG = 300;

const AVATAR_STYLES = ["fun-emoji", "bottts", "thumbs", "big-smile", "adventurer", "croodles"];

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const usedCodes = new Set<string>();
function newCode() {
  let c: string;
  do {
    c = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  } while (usedCodes.has(c));
  usedCodes.add(c);
  return c;
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

const clamp = (v: unknown, min: number, max: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

/** Chats que cada jugador puede iniciar por noche en modo automático. */
export const autoChats = (players: number) => (players <= 5 ? 2 : players <= 7 ? 3 : 4);

export type RoundResult = {
  mindId: string;
  bodyId: string;
  correct: number; // cuántas mentes rivales adivinó
  guessedBy: number; // cuántos rivales lo descubrieron
  stealth: boolean; // bonus +150
  points: number;
};

type ChatMsg = { fromBody: string; real: boolean; tag: string; text: string; ts: number };
type DmLog = { a: string; b: string; fromBody: string; text: string; ts: number }; // a = mente que escribe, b = destino

export class GameRoom extends Room<GameState> {
  maxClients = MAX_PLAYERS * 2; // holgura para que alguien retome su lugar aunque la sala esté llena
  state = new GameState();

  // Conexión <-> jugador. El id del jugador es el sessionId con el que entró la primera vez,
  // pero otra conexión puede "retomar su lugar" entrando con el mismo nombre.
  private pidOf = new Map<string, string>(); // sessionId -> playerId
  private clientOfPid = new Map<string, Client>(); // playerId -> conexión actual
  private pendingReconnect = new Map<string, Deferred<Client>>();

  // --- estado PRIVADO (nunca se sincroniza) ---
  private bodyOf = new Map<string, string>(); // mindId -> bodyId (fijo durante toda la ronda)
  private lastBodyOf = new Map<string, string>(); // ronda anterior, para no repetir cuerpo
  private dmPairs = new Set<string>(); // conversaciones abiertas esta noche ("a|b" ordenado)
  private initiated = new Map<string, number>(); // mindId -> chats que inició esta noche
  private dmLog: DmLog[] = [];
  private chatLog: ChatMsg[] = [];
  private guesses = new Map<string, Record<string, string>>(); // mindId -> { bodyId: mindId }
  private lastResults: RoundResult[] | null = null;

  onCreate() {
    this.roomId = newCode();
    this.state.minPlayers = MIN_PLAYERS;
    Object.assign(this.state.settings, { daySeconds: DAY_SECONDS, nightSeconds: NIGHT_SECONDS, guessSeconds: GUESS_SECONDS });
    this.clock.setInterval(() => this.tick(), 1000);
    this.syncMeta();

    this.onMessage("whoami", (client) => this.sendIdentity(client));

    this.onMessage("chat", (client, { text }: { text: string }) => {
      const t = clean(text);
      const ph = this.state.phase;
      if (!t || !["LOBBY", "DAY", "RESULTS"].includes(ph)) return;
      const real = ph !== "DAY"; // fuera del día se habla con la identidad real
      const fromBody = real ? this.pid(client) : this.bodyOf.get(this.pid(client)) ?? this.pid(client);
      const tag = ph === "DAY" ? `☀️ Día ${this.state.dayCount}` : ph === "RESULTS" ? "🏆 Resultados" : "🛋️ Sala de espera";
      const msg: ChatMsg = { fromBody, real, tag, text: t, ts: Date.now() };
      this.chatLog.push(msg);
      if (this.chatLog.length > MAX_CHAT_LOG) this.chatLog.shift();
      this.broadcast("chat", msg);
    });

    this.onMessage("dm", (client, { toBody, text }: { toBody: string; text: string }) => {
      const t = clean(text);
      if (!t || this.state.phase !== "NIGHT") return;
      const me = this.pid(client);
      const myBody = this.bodyOf.get(me)!;
      const target = this.mindInBody(toBody);
      if (!target || target === me) return;

      const key = [me, target].sort().join("|");
      if (!this.dmPairs.has(key)) {
        const used = this.initiated.get(me) ?? 0;
        if (used >= this.state.chatLimit) {
          return this.err(client, `Ya usaste tus ${this.state.chatLimit} chats de esta noche 🔒 (solo puedes responder a quien te escriba)`);
        }
        this.dmPairs.add(key);
        this.initiated.set(me, used + 1);
        client.send("quota", { used: used + 1 });
      }
      const ts = Date.now();
      this.dmLog.push({ a: me, b: target, fromBody: myBody, text: t, ts });
      client.send("dm", { fromBody: myBody, text: t, ts, withBody: toBody });
      this.clientOf(target)?.send("dm", { fromBody: myBody, text: t, ts, withBody: myBody });
    });

    this.onMessage("settings", (client, patch: Partial<Record<keyof Settings, number>>) => {
      if (!this.isHost(client) || this.state.phase !== "LOBBY" || !patch || typeof patch !== "object") return;
      const s = this.state.settings;
      if ("days" in patch) s.days = clamp(patch.days, 1, 6, s.days);
      if ("nights" in patch) s.nights = clamp(patch.nights, 0, 6, s.nights);
      s.nights = Math.min(s.nights, s.days);
      if ("daySeconds" in patch) s.daySeconds = clamp(patch.daySeconds, 20, 600, s.daySeconds);
      if ("nightSeconds" in patch) s.nightSeconds = clamp(patch.nightSeconds, 20, 600, s.nightSeconds);
      if ("guessSeconds" in patch) s.guessSeconds = clamp(patch.guessSeconds, 20, 300, s.guessSeconds);
      if ("chatsPerNight" in patch) s.chatsPerNight = clamp(patch.chatsPerNight, 0, 7, s.chatsPerNight);
    });

    this.onMessage("start", (client) => {
      if (!this.isHost(client) || this.state.phase !== "LOBBY") return;
      if (this.state.players.size < MIN_PLAYERS) return this.err(client, `Se necesitan al menos ${MIN_PLAYERS} jugadores.`);
      this.startRound();
    });

    // Botón maestro del host: salta sin votación.
    this.onMessage("skip", (client) => {
      if (!this.isHost(client) || !this.isPlaying()) return;
      this.broadcast("skipped", { by: "host" });
      this.advance();
    });

    // Votación de todos para saltar la fase (toggle).
    this.onMessage("voteSkip", (client) => {
      if (!["DAY", "NIGHT", "GUESS"].includes(this.state.phase)) return;
      const p = this.state.players.get(this.pid(client));
      if (!p) return;
      p.skipVote = !p.skipVote;
      this.checkSkipVotes();
    });

    this.onMessage("guesses", (client, { guesses }: { guesses: Record<string, string> }) => {
      if (this.state.phase !== "GUESS") return;
      this.guesses.set(this.pid(client), typeof guesses === "object" && guesses ? guesses : {});
      const p = this.state.players.get(this.pid(client));
      if (p) p.submitted = true;
      this.checkGuessesDone();
    });

    this.onMessage("next", (client) => {
      if (!this.isHost(client) || this.state.phase !== "RESULTS") return;
      this.backToLobby();
    });
  }

  onAuth(_client: Client, opts: { name?: string; takeover?: boolean }) {
    const existing = this.findByName(cleanName(opts?.name));
    if (existing && opts?.takeover) return { takeover: existing.id };
    if (this.state.phase !== "LOBBY") {
      throw new ServerError(4001, existing
        ? `Ya hay un ${existing.name} en la partida. Confirma que eres tú para retomar su lugar.`
        : "La partida ya empezó. Si estabas jugando, entra con el mismo nombre que tenías.");
    }
    if (this.state.players.size >= MAX_PLAYERS) throw new ServerError(4002, "La sala está llena.");
    return { takeover: null };
  }

  onJoin(client: Client, opts: { name?: string; color?: string; avatar?: string }, auth?: { takeover: string | null }) {
    if (auth?.takeover && this.state.players.has(auth.takeover)) return this.takeOver(client, auth.takeover);

    let name = cleanName(opts?.name);
    const taken = new Set([...this.state.players.values()].map((p) => p.name.toLowerCase()));
    let n = 2;
    const base = name;
    while (taken.has(name.toLowerCase())) name = `${base}${n++}`;

    const p = new Player();
    p.id = client.sessionId;
    p.name = name;
    p.color = /^#[0-9a-f]{6}$/i.test(opts?.color ?? "") ? opts!.color! : "#ff4d8d";
    p.avatar = validAvatar(opts?.avatar) ?? `${AVATAR_STYLES[0]}:${name}`;
    this.bind(client, p.id);
    this.state.players.set(p.id, p);
    if (!this.state.hostId) this.state.hostId = p.id;
    this.broadcast("joined", { id: p.id }, { except: client });
    this.syncMeta();
  }

  /** Una conexión nueva ocupa el lugar de un jugador existente (mismo cuerpo, puntos y chats). */
  private takeOver(client: Client, pid: string) {
    const p = this.state.players.get(pid)!;
    const old = this.clientOfPid.get(pid);
    const pending = this.pendingReconnect.get(pid);
    this.pendingReconnect.delete(pid);
    pending?.reject(new Error("taken over"));
    this.bind(client, pid);
    if (old && old !== client) {
      old.send("kicked", { message: `Alguien entró como ${p.name} desde otro lugar y tomó tu lugar.` });
      old.leave(4000);
    }
    p.connected = true;
    if (!this.state.players.get(this.state.hostId)?.connected) this.state.hostId = pid;
    this.broadcast("rejoined", { id: pid }, { except: client });
    this.sendIdentity(client);
    this.syncMeta();
  }

  async onLeave(client: Client, consented: boolean) {
    const id = this.pid(client);
    this.pidOf.delete(client.sessionId);
    if (this.clientOfPid.get(id) !== client) return; // ya lo reemplazó otra conexión
    this.clientOfPid.delete(id);
    const p = this.state.players.get(id);
    if (!p) return;

    if (this.state.phase === "LOBBY") {
      this.state.players.delete(id);
      this.reassignHost();
      this.syncMeta();
      return;
    }

    // En partida: mantenemos al jugador (su cuerpo sigue existiendo) y esperamos reconexión.
    p.connected = false;
    p.skipVote = false;
    this.reassignHost();
    this.checkSkipVotes();
    this.checkGuessesDone();
    this.syncMeta();
    if (consented) return;
    const d = this.allowReconnection(client, 120);
    this.pendingReconnect.set(id, d);
    try {
      const back = await d;
      this.bind(back, id);
      p.connected = true;
      if (!this.state.players.get(this.state.hostId)?.connected) this.state.hostId = id;
      this.syncMeta();
    } catch {
      /* no volvió, o alguien retomó su lugar por nombre */
    } finally {
      if (this.pendingReconnect.get(id) === d) this.pendingReconnect.delete(id);
    }
  }

  onDispose() {
    usedCodes.delete(this.roomId);
  }

  // ---------------- ciclo de juego ----------------

  private startRound() {
    this.state.round++;
    this.state.dayCount = 0;
    this.guesses.clear();
    this.chatLog = [];
    this.lastResults = null;
    for (const p of this.state.players.values()) p.submitted = false;
    this.assignBodies();
    this.setPhase("SWAP", SWAP_SECONDS);
    this.clients.forEach((c) => this.sendIdentity(c));
  }

  private isPlaying() {
    return ["SWAP", "DAY", "NIGHT", "GUESS"].includes(this.state.phase);
  }

  private tick() {
    if (!this.isPlaying()) return;
    if (this.state.timer > 0) this.state.timer--;
    if (this.state.timer <= 0) this.advance();
  }

  /**
   * Secuencia: SWAP → Día 1 → (Noche 1) → Día 2 → ... → Día N → (Noche N) → GUESS → RESULTS.
   * Hay noche después de cada día mientras dayCount <= settings.nights.
   */
  private advance() {
    const { days, nights, daySeconds, nightSeconds, guessSeconds } = this.state.settings;
    const nextDayOrGuess = () => {
      if (this.state.dayCount < days) {
        this.state.dayCount++;
        this.setPhase("DAY", daySeconds);
      } else this.setPhase("GUESS", guessSeconds);
    };
    switch (this.state.phase) {
      case "SWAP":
        nextDayOrGuess();
        break;
      case "DAY":
        if (this.state.dayCount <= nights) this.startNight(nightSeconds);
        else nextDayOrGuess();
        break;
      case "NIGHT":
        nextDayOrGuess();
        break;
      case "GUESS":
        this.computeResults();
        this.setPhase("RESULTS", 0);
        break;
    }
  }

  private startNight(seconds: number) {
    this.dmPairs.clear();
    this.initiated.clear();
    this.dmLog = [];
    const s = this.state.settings;
    this.state.chatLimit = s.chatsPerNight > 0 ? s.chatsPerNight : autoChats(this.state.players.size);
    this.setPhase("NIGHT", seconds);
  }

  private setPhase(phase: GameState["phase"], seconds: number) {
    const changed = this.state.phase !== phase;
    this.state.phase = phase;
    this.state.timer = seconds;
    for (const p of this.state.players.values()) p.skipVote = false;
    if (changed) this.syncMeta();
  }

  private checkSkipVotes() {
    if (!["DAY", "NIGHT", "GUESS"].includes(this.state.phase)) return;
    const connected = [...this.state.players.values()].filter((p) => p.connected);
    const votes = connected.filter((p) => p.skipVote).length;
    if (votes > 0 && votes >= skipNeeded(connected.length)) {
      this.broadcast("skipped", { by: "vote" });
      this.advance();
    }
  }

  private checkGuessesDone() {
    if (this.state.phase !== "GUESS") return;
    const pending = [...this.state.players.values()].some((p) => p.connected && !p.submitted);
    if (!pending) this.advance();
  }

  /**
   * Un único cambio por ronda, antes del Día 1. Derangement: nadie queda en su propio cuerpo
   * y, si se puede, nadie repite el cuerpo que tuvo la ronda anterior.
   */
  private assignBodies() {
    const minds = shuffle([...this.state.players.keys()]);
    this.bodyOf.clear();
    if (minds.length < 2) {
      minds.forEach((m) => this.bodyOf.set(m, m));
      return;
    }
    const bad = (next: string[], strict: boolean) =>
      next.some((b, i) => b === minds[i] || (strict && b === this.lastBodyOf.get(minds[i])));
    let next = shuffle(minds);
    for (let tries = 0; tries < 5000 && bad(next, tries < 2000); tries++) next = shuffle(minds);
    minds.forEach((m, i) => this.bodyOf.set(m, next[i]));
    this.lastBodyOf = new Map(this.bodyOf);
  }

  private computeResults() {
    const minds = [...this.bodyOf.keys()];
    const rivals = minds.length - 1;
    const results: RoundResult[] = minds.map((m) => {
      const myGuess = this.guesses.get(m) ?? {};
      const myBody = this.bodyOf.get(m)!;
      let correct = 0;
      for (const other of minds) {
        if (other === m) continue;
        if (myGuess[this.bodyOf.get(other)!] === other) correct++;
      }
      const guessedBy = minds.filter((o) => o !== m && this.guesses.get(o)?.[myBody] === m).length;
      const stealth = guessedBy < rivals * 0.5;
      const points = correct * 200 + (stealth ? 150 : 0);
      const p = this.state.players.get(m);
      if (p) p.score += points;
      return { mindId: m, bodyId: myBody, correct, guessedBy, stealth, points };
    });
    this.lastResults = results;
    this.broadcast("results", results);
  }

  private backToLobby() {
    for (const p of [...this.state.players.values()]) {
      if (!p.connected) {
        this.state.players.delete(p.id);
        this.pendingReconnect.get(p.id)?.reject(new Error("removed"));
        this.pendingReconnect.delete(p.id);
      }
      else p.submitted = false;
    }
    this.bodyOf.clear();
    this.guesses.clear();
    this.dmLog = [];
    this.lastResults = null;
    this.state.dayCount = 0;
    this.setPhase("LOBBY", 0);
    this.reassignHost();
    this.clients.forEach((c) => this.sendIdentity(c));
  }

  // ---------------- helpers ----------------

  /** Todo lo privado que un cliente necesita (también sirve para reconectar). */
  private sendIdentity(client: Client) {
    const id = this.pid(client);
    client.send("identity", { mindId: id, bodyId: this.bodyOf.get(id) ?? id });
    client.send("chatHistory", this.chatLog);
    if (this.state.phase === "NIGHT") {
      client.send("quota", { used: this.initiated.get(id) ?? 0 });
      const mine = this.dmLog
        .filter((d) => d.a === id || d.b === id)
        .map((d) => ({ fromBody: d.fromBody, text: d.text, ts: d.ts, withBody: this.bodyOf.get(d.a === id ? d.b : d.a)! }));
      client.send("dmHistory", mine);
    }
    if (this.state.phase === "RESULTS" && this.lastResults) client.send("results", this.lastResults);
  }

  private mindInBody(bodyId: string) {
    for (const [m, b] of this.bodyOf) if (b === bodyId) return m;
    return undefined;
  }

  private pid(client: Client) {
    return this.pidOf.get(client.sessionId) ?? client.sessionId;
  }

  private bind(client: Client, pid: string) {
    this.pidOf.set(client.sessionId, pid);
    this.clientOfPid.set(pid, client);
  }

  private clientOf(id: string) {
    return this.clientOfPid.get(id);
  }

  private findByName(name: string) {
    const n = name.toLowerCase();
    return [...this.state.players.values()].find((p) => p.name.toLowerCase() === n);
  }

  /** Lo que ve /api/rooms/:code antes de entrar (fase y nombres para reconectar). */
  private syncMeta() {
    const players = [...this.state.players.values()];
    this.setMetadata({ phase: this.state.phase, names: players.map((p) => p.name), connected: players.map((p) => p.connected) });
  }

  private isHost(client: Client) {
    return this.pid(client) === this.state.hostId;
  }

  private reassignHost() {
    const host = this.state.players.get(this.state.hostId);
    if (host?.connected) return;
    const next = [...this.state.players.values()].find((p) => p.connected);
    this.state.hostId = next?.id ?? "";
  }

  private err(client: Client, message: string) {
    client.send("error", { message });
  }
}

/** Mayoría simple de los conectados. */
export const skipNeeded = (connected: number) => Math.floor(connected / 2) + 1;

function validAvatar(a: unknown) {
  if (typeof a !== "string") return undefined;
  const [style, seed] = a.split(":");
  return AVATAR_STYLES.includes(style) && /^[a-z0-9]{1,24}$/i.test(seed ?? "") ? a : undefined;
}

function cleanName(s: unknown) {
  return clean(s).slice(0, 16) || "Anónimo";
}

function clean(s: unknown) {
  return typeof s === "string" ? s.trim().slice(0, 300) : "";
}

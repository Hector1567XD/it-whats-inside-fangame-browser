import { Room, Client, ServerError, type Deferred } from "@colyseus/core";
import { GameState, Player, Post, Reply, type Mode, type Phase, type Settings } from "./GameState.js";
import { QUESTIONS } from "./questions.js";

const num = (v: string | undefined, d: number) => (v && !isNaN(+v) ? +v : d);
const SWAP_SECONDS = num(process.env.SWAP_SECONDS, 10); // animación de cambio de cuerpos al empezar
const MIN_PLAYERS_ENV = process.env.MIN_PLAYERS ? num(process.env.MIN_PLAYERS, 5) : undefined; // override para pruebas
const MIN_PLAYERS: Record<Mode, number> = { classic: 5, all: 4 };
const MAX_PLAYERS = 12;
const MAX_CHAT_LOG = 300;
const MAX_REPLIES = 80;

const AVATAR_STYLES = ["big-smile", "adventurer", "croodles"];

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

const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

const clamp = (v: unknown, min: number, max: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

/** Chats que cada jugador puede iniciar por noche en modo automático. */
export const autoChats = (players: number) => Math.min(5, Math.max(2, Math.floor(players / 2)));

/**
 * Cuántos cambian de cuerpo. Clásico: entre 2 y N-2 al azar (siempre quedan al menos 2 en su cuerpo),
 * nadie sabe cuántos. Todos cambian: todos.
 */
export function swapCount(mode: Mode, n: number) {
  if (n < 2) return 0;
  if (mode === "all") return n;
  return randInt(2, Math.max(2, n - 2));
}

export type RoundResult = {
  mindId: string;
  bodyId: string;
  swapped: boolean;
  hits: number; // cuerpos cambiados que adivinó (+200 c/u)
  sameHits: number; // acertó que alguien NO cambió (+50 c/u)
  guessedBy: number; // rivales que adivinaron qué mente había en su cuerpo
  fooled: number; // (si no cambió) rivales que creyeron que sí cambió
  bonus: "stealth" | "decoy" | null; // +150
  points: number;
};
export type ResultsPayload = {
  mode: Mode;
  results: RoundResult[];
  guesses: Record<string, Record<string, string>>; // mente -> { cuerpo: mente adivinada }
};

type ChatMsg = { fromBody: string; real: boolean; tag: string; text: string; ts: number };
type DmLog = { a: string; b: string; fromBody: string; text: string; ts: number }; // a = mente que escribe, b = destino

const PLAYING: Phase[] = ["SWAP", "QUESTION", "THREAD", "DAY", "NIGHT", "GUESS"];
const SKIPPABLE: Phase[] = ["QUESTION", "THREAD", "DAY", "NIGHT", "GUESS"];

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
  private answers = new Map<string, string>(); // mindId -> respuesta a La Pregunta
  private likedBy = new Map<string, Set<string>>(); // post/reply id -> mentes que dieron like
  private usedQuestions = new Set<string>();
  private seq = 0;
  private guesses = new Map<string, Record<string, string>>(); // mindId -> { bodyId: mindId }
  private lastResults: ResultsPayload | null = null;

  onCreate(opts: { mode?: string }) {
    this.roomId = newCode();
    this.setMode(opts?.mode === "all" ? "all" : "classic");
    this.state.maxPlayers = MAX_PLAYERS;
    this.clock.setInterval(() => this.tick(), 1000);
    this.syncMeta();

    this.onMessage("whoami", (client) => this.sendIdentity(client));

    this.onMessage("chat", (client, { text }: { text: string }) => {
      const t = clean(text);
      const ph = this.state.phase;
      if (!t || !["LOBBY", "DAY", "RESULTS"].includes(ph)) return;
      const real = ph !== "DAY"; // fuera del día se habla con la identidad real
      const fromBody = real ? this.pid(client) : this.bodyOf.get(this.pid(client)) ?? this.pid(client);
      const tag = ph === "DAY"
        ? `☀️ Chat global${this.state.settings.cycles > 1 ? ` · ciclo ${this.state.cycle}` : ""}`
        : ph === "RESULTS" ? "🏆 Resultados" : "🛋️ Sala de espera";
      const msg: ChatMsg = { fromBody, real, tag, text: t, ts: Date.now() };
      this.chatLog.push(msg);
      if (this.chatLog.length > MAX_CHAT_LOG) this.chatLog.shift();
      this.broadcast("chat", msg);
    });

    this.onMessage("answer", (client, { text }: { text: string }) => {
      const t = clean(text).slice(0, 200);
      if (!t || this.state.phase !== "QUESTION") return;
      const me = this.pid(client);
      this.answers.set(me, t);
      const p = this.state.players.get(me);
      if (p) p.submitted = true;
      if (this.allConnectedSubmitted()) this.advance();
    });

    this.onMessage("reply", (client, { text }: { text: string }) => {
      const t = clean(text).slice(0, 200);
      const post = this.state.posts[this.state.thread];
      if (!t || this.state.phase !== "THREAD" || !post || post.replies.length >= MAX_REPLIES) return;
      const r = new Reply();
      r.id = `r${++this.seq}`;
      r.body = this.bodyOf.get(this.pid(client)) ?? this.pid(client);
      r.text = t;
      post.replies.push(r);
    });

    this.onMessage("like", (client, { id }: { id: string }) => {
      if (!["THREAD", "DAY"].includes(this.state.phase) || typeof id !== "string") return;
      const target = this.findLikeable(id);
      if (!target) return;
      let set = this.likedBy.get(id);
      if (!set) this.likedBy.set(id, (set = new Set()));
      const me = this.pid(client);
      set.has(me) ? set.delete(me) : set.add(me);
      target.likes = set.size;
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

    this.onMessage("settings", (client, patch: Partial<Record<keyof Settings, number | string>>) => {
      if (!this.isHost(client) || this.state.phase !== "LOBBY" || !patch || typeof patch !== "object") return;
      const s = this.state.settings;
      if (patch.mode === "classic" || patch.mode === "all") this.setMode(patch.mode);
      if ("cycles" in patch) s.cycles = clamp(patch.cycles, 1, 5, s.cycles);
      // 0 apaga la fase (menos la adivinanza)
      if ("questionSeconds" in patch) s.questionSeconds = clamp(patch.questionSeconds, 0, 180, s.questionSeconds);
      if ("threadSeconds" in patch) s.threadSeconds = clamp(patch.threadSeconds, 0, 120, s.threadSeconds);
      if ("daySeconds" in patch) s.daySeconds = clamp(patch.daySeconds, 0, 600, s.daySeconds);
      if ("nightSeconds" in patch) s.nightSeconds = clamp(patch.nightSeconds, 0, 600, s.nightSeconds);
      if ("guessSeconds" in patch) s.guessSeconds = clamp(patch.guessSeconds, 20, 300, s.guessSeconds);
      if ("chatsPerNight" in patch) s.chatsPerNight = clamp(patch.chatsPerNight, 0, 7, s.chatsPerNight);
    });

    this.onMessage("start", (client) => {
      if (!this.isHost(client) || this.state.phase !== "LOBBY") return;
      if (this.state.players.size < this.state.minPlayers) {
        return this.err(client, `Se necesitan al menos ${this.state.minPlayers} jugadores para este modo.`);
      }
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
      if (!SKIPPABLE.includes(this.state.phase)) return;
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
      if (this.allConnectedSubmitted()) this.advance();
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

  private setMode(mode: Mode) {
    this.state.settings.mode = mode;
    this.state.minPlayers = MIN_PLAYERS_ENV ?? MIN_PLAYERS[mode];
  }

  private startRound() {
    this.state.round++;
    this.state.cycle = 0;
    this.guesses.clear();
    this.chatLog = [];
    this.lastResults = null;
    this.state.posts.clear();
    this.state.question = "";
    for (const p of this.state.players.values()) p.submitted = false;
    this.assignBodies();
    this.setPhase("SWAP", SWAP_SECONDS);
    this.clients.forEach((c) => this.sendIdentity(c));
  }

  private isPlaying() {
    return PLAYING.includes(this.state.phase);
  }

  private tick() {
    if (!this.isPlaying()) return;
    if (this.state.timer > 0) this.state.timer--;
    if (this.state.timer <= 0) this.advance();
  }

  /** Fases de un ciclo según la config (tiempo 0 = fase apagada). */
  private cyclePhases(): Phase[] {
    const s = this.state.settings;
    const list: Phase[] = [];
    if (s.questionSeconds > 0) {
      list.push("QUESTION");
      if (s.threadSeconds > 0) list.push("THREAD");
    }
    if (s.daySeconds > 0) list.push("DAY");
    if (s.nightSeconds > 0) list.push("NIGHT");
    return list;
  }

  /**
   * SWAP → [La Pregunta → El Hilo (un post a la vez) → Chat global → Chat privado] × ciclos → GUESS → RESULTS.
   */
  private advance() {
    const ph = this.state.phase;
    if (ph === "THREAD" && this.state.thread < this.state.posts.length - 1) {
      this.state.thread++;
      this.setPhase("THREAD", this.state.settings.threadSeconds);
      return;
    }
    if (ph === "GUESS") {
      this.computeResults();
      this.setPhase("RESULTS", 0);
      return;
    }
    if (!this.isPlaying()) return;
    const list = this.cyclePhases();
    if (ph === "SWAP") {
      this.state.cycle = 1;
      return this.goTo(list, 0);
    }
    this.goTo(list, list.indexOf(ph) + 1);
  }

  private goTo(list: Phase[], i: number): void {
    if (i >= list.length) {
      if (list.length > 0 && this.state.cycle < this.state.settings.cycles) {
        this.state.cycle++;
        i = 0;
      } else return this.enterGuess();
    }
    const s = this.state.settings;
    switch (list[i]) {
      case "QUESTION": {
        this.answers.clear();
        this.likedBy.clear();
        this.state.posts.clear();
        this.state.question = this.pickQuestion();
        for (const p of this.state.players.values()) p.submitted = false;
        return this.setPhase("QUESTION", s.questionSeconds);
      }
      case "THREAD": {
        const answered = shuffle([...this.answers.entries()]);
        if (answered.length === 0) return this.goTo(list, i + 1); // nadie respondió: no hay hilo
        for (const [mind, text] of answered) {
          const post = new Post();
          post.id = `p${++this.seq}`;
          post.body = this.bodyOf.get(mind) ?? mind;
          post.text = text;
          this.state.posts.push(post);
        }
        this.state.thread = 0;
        return this.setPhase("THREAD", s.threadSeconds);
      }
      case "DAY":
        return this.setPhase("DAY", s.daySeconds);
      case "NIGHT":
        return this.startNight(s.nightSeconds);
    }
  }

  private enterGuess() {
    for (const p of this.state.players.values()) p.submitted = false;
    this.setPhase("GUESS", this.state.settings.guessSeconds);
  }

  private pickQuestion() {
    let pool = QUESTIONS.filter((q) => !this.usedQuestions.has(q));
    if (pool.length === 0) {
      this.usedQuestions.clear();
      pool = QUESTIONS;
    }
    const q = pool[Math.floor(Math.random() * pool.length)];
    this.usedQuestions.add(q);
    return q;
  }

  private findLikeable(id: string): Post | Reply | undefined {
    for (const p of this.state.posts) {
      if (p.id === id) return p;
      const r = p.replies.find((x) => x.id === id);
      if (r) return r;
    }
    return undefined;
  }

  private startNight(seconds: number) {
    this.dmPairs.clear();
    this.initiated.clear();
    this.dmLog = [];
    const s = this.state.settings;
    this.state.chatLimit = s.chatsPerNight > 0 ? s.chatsPerNight : autoChats(this.state.players.size);
    this.setPhase("NIGHT", seconds);
  }

  private setPhase(phase: Phase, seconds: number) {
    const changed = this.state.phase !== phase;
    this.state.phase = phase;
    this.state.timer = seconds;
    for (const p of this.state.players.values()) p.skipVote = false;
    if (changed) this.syncMeta();
  }

  private checkSkipVotes() {
    if (!SKIPPABLE.includes(this.state.phase)) return;
    const connected = [...this.state.players.values()].filter((p) => p.connected);
    const votes = connected.filter((p) => p.skipVote).length;
    if (votes > 0 && votes >= skipNeeded(connected.length)) {
      this.broadcast("skipped", { by: "vote" });
      this.advance();
    }
  }

  private allConnectedSubmitted() {
    return ![...this.state.players.values()].some((p) => p.connected && !p.submitted);
  }

  private checkGuessesDone() {
    if (["QUESTION", "GUESS"].includes(this.state.phase) && this.allConnectedSubmitted()) this.advance();
  }

  /**
   * Un único cambio por ronda, al empezar. Los que cambian forman un derangement entre ellos
   * (ninguno queda en su cuerpo) y, si se puede, nadie repite el cuerpo de la ronda anterior.
   */
  private assignBodies() {
    const all = shuffle([...this.state.players.keys()]);
    this.bodyOf.clear();
    all.forEach((m) => this.bodyOf.set(m, m));
    const k = swapCount(this.state.settings.mode, all.length);
    const minds = all.slice(0, k);
    if (minds.length >= 2) {
      const bad = (next: string[], strict: boolean) =>
        next.some((b, i) => b === minds[i] || (strict && b === this.lastBodyOf.get(minds[i])));
      let next = shuffle(minds);
      for (let tries = 0; tries < 5000 && bad(next, tries < 2000); tries++) next = shuffle(minds);
      minds.forEach((m, i) => this.bodyOf.set(m, next[i]));
    }
    this.lastBodyOf = new Map(this.bodyOf);
  }

  private computeResults() {
    const minds = [...this.bodyOf.keys()];
    const rivals = minds.length - 1;
    const classic = this.state.settings.mode === "classic";

    // Normalizamos: en clásico, un cuerpo sin marcar = "no cambió" (su dueño).
    const norm: Record<string, Record<string, string>> = {};
    for (const m of minds) {
      const raw = this.guesses.get(m) ?? {};
      const g: Record<string, string> = {};
      for (const b of minds) {
        if (b === this.bodyOf.get(m)) continue;
        const v = typeof raw[b] === "string" && this.bodyOf.has(raw[b]) ? raw[b] : "";
        g[b] = v || (classic ? b : "");
      }
      norm[m] = g;
    }

    const results: RoundResult[] = minds.map((m) => {
      const myBody = this.bodyOf.get(m)!;
      const swapped = myBody !== m;
      let hits = 0;
      let sameHits = 0;
      for (const o of minds) {
        if (o === m) continue;
        const b = this.bodyOf.get(o)!;
        if (norm[m][b] === o) b === o ? sameHits++ : hits++;
      }
      const others = minds.filter((o) => o !== m);
      const guessedBy = others.filter((o) => norm[o][myBody] === m).length;
      const fooled = swapped ? 0 : others.filter((o) => norm[o][myBody] && norm[o][myBody] !== m).length;
      const bonus = swapped
        ? (guessedBy < rivals * 0.5 ? "stealth" : null)
        : (rivals > 0 && fooled >= rivals * 0.5 ? "decoy" : null);
      const points = hits * 200 + sameHits * 50 + (bonus ? 150 : 0);
      const p = this.state.players.get(m);
      if (p) {
        p.score += points;
        p.lastPoints = points;
      }
      return { mindId: m, bodyId: myBody, swapped, hits, sameHits, guessedBy, fooled, bonus, points };
    });
    this.lastResults = { mode: this.state.settings.mode, results, guesses: norm };
    this.broadcast("results", this.lastResults);
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
    this.state.cycle = 0;
    this.state.posts.clear();
    this.state.question = "";
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

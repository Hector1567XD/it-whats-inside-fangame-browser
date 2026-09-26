import { Room, Client } from "@colyseus/core";
import { GameState, Player } from "./GameState.js";

const num = (v: string | undefined, d: number) => (v && !isNaN(+v) ? +v : d);
const DAY_SECONDS = num(process.env.DAY_SECONDS, 120);
const NIGHT_SECONDS = num(process.env.NIGHT_SECONDS, 90);
const GUESS_SECONDS = num(process.env.GUESS_SECONDS, 90);
const MIN_PLAYERS = num(process.env.MIN_PLAYERS, 4);
const MAX_PLAYERS = 8;
const TOTAL_DAYS = 3;
const MAX_DM_PARTNERS = 2;

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

export type RoundResult = {
  mindId: string;
  finalBodyId: string;
  history: string[]; // cuerpos por los que pasó (incluye el suyo al inicio)
  correct: number; // cuántas mentes rivales adivinó
  guessedBy: number; // cuántos rivales lo descubrieron
  stealth: boolean; // bonus +150
  points: number;
};

export class GameRoom extends Room<GameState> {
  maxClients = MAX_PLAYERS;
  state = new GameState();

  // --- estado PRIVADO (nunca se sincroniza) ---
  private bodyOf = new Map<string, string>(); // mindId -> bodyId
  private history = new Map<string, string[]>();
  private dmPartners = new Map<string, Set<string>>(); // mindId -> minds con los que habló esta noche
  private guesses = new Map<string, Record<string, string>>(); // mindId -> { bodyId: mindId }
  private lastResults: RoundResult[] | null = null;

  onCreate() {
    this.roomId = newCode();
    this.state.minPlayers = MIN_PLAYERS;
    this.clock.setInterval(() => this.tick(), 1000);

    this.onMessage("whoami", (client) => this.sendIdentity(client));

    this.onMessage("chat", (client, { text }: { text: string }) => {
      const t = clean(text);
      if (!t || !["LOBBY", "DAY", "RESULTS"].includes(this.state.phase)) return;
      const fromBody = this.bodyOf.get(client.sessionId) ?? client.sessionId;
      this.broadcast("chat", { fromBody, text: t, ts: Date.now() });
    });

    this.onMessage("dm", (client, { toBody, text }: { toBody: string; text: string }) => {
      const t = clean(text);
      if (!t || this.state.phase !== "NIGHT") return;
      const me = client.sessionId;
      const myBody = this.bodyOf.get(me)!;
      const target = this.mindInBody(toBody);
      if (!target || target === me) return;

      const mine = this.partners(me);
      const theirs = this.partners(target);
      if (!mine.has(target)) {
        if (mine.size >= MAX_DM_PARTNERS) return this.err(client, `Solo puedes hablar con ${MAX_DM_PARTNERS} cuerpos por noche.`);
        if (theirs.size >= MAX_DM_PARTNERS) return this.err(client, "Ese cuerpo ya no acepta más conversaciones esta noche.");
        mine.add(target);
        theirs.add(me);
      }
      const msg = { fromBody: myBody, text: t, ts: Date.now() };
      client.send("dm", { ...msg, withBody: toBody });
      this.clientOf(target)?.send("dm", { ...msg, withBody: myBody });
    });

    this.onMessage("start", (client) => {
      if (!this.isHost(client) || this.state.phase !== "LOBBY") return;
      if (this.state.players.size < MIN_PLAYERS) return this.err(client, `Se necesitan al menos ${MIN_PLAYERS} jugadores.`);
      this.startRound();
    });

    this.onMessage("skip", (client) => {
      if (this.isHost(client)) this.advance();
    });

    this.onMessage("guesses", (client, { guesses }: { guesses: Record<string, string> }) => {
      if (this.state.phase !== "GUESS") return;
      this.guesses.set(client.sessionId, typeof guesses === "object" && guesses ? guesses : {});
      const p = this.state.players.get(client.sessionId);
      if (p) p.submitted = true;
      const pending = [...this.state.players.values()].some((p) => p.connected && !p.submitted);
      if (!pending) this.advance();
    });

    this.onMessage("next", (client) => {
      if (!this.isHost(client) || this.state.phase !== "RESULTS") return;
      this.backToLobby();
    });
  }

  onJoin(client: Client, opts: { name?: string; color?: string }) {
    let name = clean(opts?.name ?? "").slice(0, 16) || "Anónimo";
    const taken = new Set([...this.state.players.values()].map((p) => p.name.toLowerCase()));
    let n = 2;
    const base = name;
    while (taken.has(name.toLowerCase())) name = `${base}${n++}`;

    const p = new Player();
    p.id = client.sessionId;
    p.name = name;
    p.color = /^#[0-9a-f]{6}$/i.test(opts?.color ?? "") ? opts!.color! : "#ff4d8d";
    this.state.players.set(client.sessionId, p);
    if (!this.state.hostId) this.state.hostId = client.sessionId;
  }

  async onLeave(client: Client, consented: boolean) {
    const id = client.sessionId;
    const p = this.state.players.get(id);
    if (!p) return;

    if (this.state.phase === "LOBBY") {
      this.state.players.delete(id);
      this.reassignHost();
      return;
    }

    // En partida: mantenemos al jugador (su cuerpo sigue existiendo) y esperamos reconexión.
    p.connected = false;
    this.reassignHost();
    if (consented) return;
    try {
      await this.allowReconnection(client, 120);
      p.connected = true;
      if (!this.state.hostId || !this.state.players.get(this.state.hostId)?.connected) this.state.hostId = id;
    } catch {
      /* no volvió */
    }
  }

  onDispose() {
    usedCodes.delete(this.roomId);
  }

  // ---------------- ciclo de juego ----------------

  private startRound() {
    this.lock();
    this.state.round++;
    this.state.dayCount = 1;
    this.bodyOf.clear();
    this.history.clear();
    this.guesses.clear();
    this.lastResults = null;
    for (const p of this.state.players.values()) {
      this.bodyOf.set(p.id, p.id);
      this.history.set(p.id, [p.id]);
      p.submitted = false;
    }
    this.setPhase("DAY", DAY_SECONDS);
    this.clients.forEach((c) => this.sendIdentity(c));
  }

  private tick() {
    if (!["DAY", "NIGHT", "GUESS"].includes(this.state.phase)) return;
    if (this.state.timer > 0) this.state.timer--;
    if (this.state.timer <= 0) this.advance();
  }

  private advance() {
    switch (this.state.phase) {
      case "DAY":
        this.nightSwap();
        this.dmPartners.clear();
        this.setPhase("NIGHT", NIGHT_SECONDS);
        break;
      case "NIGHT":
        if (this.state.dayCount < TOTAL_DAYS) {
          this.state.dayCount++;
          this.setPhase("DAY", DAY_SECONDS);
        } else {
          this.setPhase("GUESS", GUESS_SECONDS);
        }
        break;
      case "GUESS":
        this.computeResults();
        this.setPhase("RESULTS", 0);
        break;
    }
  }

  private setPhase(phase: GameState["phase"], seconds: number) {
    this.state.phase = phase;
    this.state.timer = seconds;
  }

  /** Derangement: nadie se queda en el cuerpo que tenía. */
  private nightSwap() {
    const minds = [...this.bodyOf.keys()];
    const current = minds.map((m) => this.bodyOf.get(m)!);
    // Preferimos además que nadie vuelva a su cuerpo ORIGINAL (más confusión). Si no se puede, solo evitamos el actual.
    const bad = (next: string[], strict: boolean) => next.some((b, i) => b === current[i] || (strict && b === minds[i]));
    let next = shuffle(current);
    for (let tries = 0; bad(next, tries < 500); tries++) next = shuffle(current);
    minds.forEach((m, i) => {
      this.bodyOf.set(m, next[i]);
      this.history.get(m)!.push(next[i]);
    });
    this.clients.forEach((c) => this.sendIdentity(c));
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
      return { mindId: m, finalBodyId: myBody, history: this.history.get(m) ?? [], correct, guessedBy, stealth, points };
    });
    this.lastResults = results;
    this.broadcast("results", results);
  }

  private backToLobby() {
    for (const p of [...this.state.players.values()]) {
      if (!p.connected) this.state.players.delete(p.id);
      else p.submitted = false;
    }
    this.bodyOf.clear();
    this.history.clear();
    this.guesses.clear();
    this.lastResults = null;
    this.state.dayCount = 0;
    this.setPhase("LOBBY", 0);
    this.reassignHost();
    this.unlock();
    this.clients.forEach((c) => this.sendIdentity(c));
  }

  // ---------------- helpers ----------------

  private sendIdentity(client: Client) {
    const id = client.sessionId;
    client.send("identity", { mindId: id, bodyId: this.bodyOf.get(id) ?? id });
    if (this.state.phase === "RESULTS" && this.lastResults) client.send("results", this.lastResults);
  }

  private mindInBody(bodyId: string) {
    for (const [m, b] of this.bodyOf) if (b === bodyId) return m;
    return undefined;
  }

  private partners(mind: string) {
    let s = this.dmPartners.get(mind);
    if (!s) this.dmPartners.set(mind, (s = new Set()));
    return s;
  }

  private clientOf(id: string) {
    return this.clients.find((c) => c.sessionId === id);
  }

  private isHost(client: Client) {
    return client.sessionId === this.state.hostId;
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

function clean(s: unknown) {
  return typeof s === "string" ? s.trim().slice(0, 300) : "";
}

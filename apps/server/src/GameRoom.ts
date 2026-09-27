import { Room, Client, ServerError, type Deferred } from "@colyseus/core";
import { GameState, Player, Post, Reply, type Mode, type NightMode, type Phase, type Settings } from "./GameState.js";
import { QUESTIONS } from "./questions.js";
import { sfu, sfuEnabled, iceServers, type SessionDescription } from "./sfu.js";
import {
  MODES, autoChats, autoCycles, isImmutableMode, minPlayersFor, resolveUnmask, resolvePlurality, skipNeeded, swapCount,
  channels, hasRadioPhase, scoreExact, POINTS, type ExactScore, type Verdict,
} from "./rules.js";

const num = (v: string | undefined, d: number) => (v && !isNaN(+v) ? +v : d);
const SWAP_SECONDS = num(process.env.SWAP_SECONDS, 10); // animación de cambio de cuerpos
const VERDICT_SECONDS = num(process.env.VERDICT_SECONDS, 8); // anuncio del resultado de una votación
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

const clamp = (v: unknown, min: number, max: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export type RoundResult = {
  mindId: string;
  bodyId: string;
  swapped: boolean;
  out: boolean; // lo desenmascararon en la ronda
  hits: number; // cuerpos cambiados que adivinó (+200 c/u)
  sameHits: number; // acertó que alguien NO cambió (+50 c/u)
  guessedBy: number;
  fooled: number;
  bonus: "stealth" | "decoy" | null;
  early: number; // puntos ganados/perdidos en desenmascares
  exact: number; // 🎯 Exactitud: puntos por lo bien que imitó al dueño del cuerpo
  points: number; // total de la ronda
};
export type Ejection = { cycle: number; kind: "UNMASK" | "VOTE" | "FINAL_VOTE"; bodyId: string; mindId: string; wasImmutable: boolean };
/** 📜 Detalles de la ronda (se ven en los resultados, ya sin secretos). Cuerpos y mentes de ese momento. */
export type NightEdge = { aBody: string; bBody: string; aMind: string; bMind: string; dms: number; calls: number; callSec: number; last: number };
export type ThreadLogPost = { id: string; body: string; mind: string; text: string; likes: number; sus: number; replies: Omit<ThreadLogPost, "replies">[] };
export type RoundDetails = {
  nights: { cycle: number; edges: NightEdge[] }[];
  threads: { cycle: number; question: string; posts: ThreadLogPost[] }[];
  votes: { cycle: number; kind: Ejection["kind"]; ballots: { voter: string; voterBody: string; body: string | null; mind?: string }[] }[];
  chat: Record<string, number>; // mente -> mensajes en el chat global de la partida
  history: Record<string, string[]>; // mente -> cuerpos por los que pasó
};
type GuessBlock = { results: RoundResult[]; guesses: Record<string, Record<string, string>> };
export type ResultsPayload = { details: RoundDetails; exact: ExactScore[] | null } & (
  | ({ family: "guess"; mode: Mode; ejections: Ejection[] } & GuessBlock)
  | {
      family: "immutable"; mode: Mode; immutableId: string; winner: "changers" | "immutable";
      bodies: Record<string, string>; // mente -> cuerpo final
      history: Record<string, string[]>; // mente -> cuerpos por los que pasó
      ejections: Ejection[]; points: Record<string, number>;
      guess: GuessBlock | null; // 🧩 ¿Quién es quién? antes del Juicio Final (si estaba activo)
    }
);

type Quote = { id: string; body: string; text: string }; // cotorreo citado en el chat global
type ChatMsg = { fromBody: string; real: boolean; tag: string; text: string; ts: number; quote?: Quote };
type DmLog = { a: string; b: string; fromBody: string; text: string; ts: number }; // a = mente que escribe, b = destino

const PLAYING: Phase[] = ["SWAP", "QUESTION", "THREAD", "DAY", "NIGHT", "RADIO", "UNMASK", "VOTE", "VERDICT", "GUESS", "FINAL_VOTE", "EXACT"];
const SKIPPABLE: Phase[] = ["QUESTION", "THREAD", "DAY", "NIGHT", "RADIO", "UNMASK", "VOTE", "GUESS", "FINAL_VOTE", "EXACT"];
const SUBMIT_PHASES: Phase[] = ["QUESTION", "UNMASK", "VOTE", "GUESS", "FINAL_VOTE", "EXACT"];
const PRIVATE_PHASES: Phase[] = ["NIGHT", "RADIO"];
const CHAT_TAGS: Partial<Record<Phase, string>> = {
  DAY: "☀️ Chat global", UNMASK: "🎭 El Desenmascare", VOTE: "🗳️ La Votación", FINAL_VOTE: "⚖️ Juicio Final",
  GUESS: "🧩 ¿Quién es quién?", EXACT: "🎯 Exactitud",
};
const REACTIONS = ["😂", "😭", "😊", "❤️", "😡", "👏", "🤔", "👀", "🤡"];
const VOICES = ["", "listen", "fem", "masc", "neutral"];
const RTC_MAX_BYTES = 20_000; // una oferta SDP de audio pesa ~3-6 KB
const RTC_PER_SECOND = 50;
/** Contadores de la señalización de voz, para el log periódico de index.ts. */
export const rtcStats = { relayed: 0, dropped: 0, sfuCalls: 0, sfuErrors: 0 };
const VOICE_TRACK = "voice";

/** Voz por Cloudflare SFU: sesiones de cada jugador (privado; el navegador nunca ve los ids de los demás). */
type SfuPeer = { pub?: string; pubMid?: string; ready: boolean; sub?: string; sent?: string };
type SfuMsg = { rid?: number; op?: string; sdp?: SessionDescription; mid?: string; pids?: string[]; mids?: string[] };

export class GameRoom extends Room<GameState> {
  maxClients = MAX_PLAYERS * 2; // holgura para que alguien retome su lugar aunque la sala esté llena
  state = new GameState();

  // Conexión <-> jugador. El id del jugador es el sessionId con el que entró la primera vez,
  // pero otra conexión puede "retomar su lugar" entrando con el mismo nombre.
  private pidOf = new Map<string, string>(); // sessionId -> playerId
  private clientOfPid = new Map<string, Client>(); // playerId -> conexión actual
  private pendingReconnect = new Map<string, Deferred<Client>>();

  // --- estado PRIVADO (nunca se sincroniza) ---
  private bodyOf = new Map<string, string>(); // mindId -> bodyId
  private lastBodyOf = new Map<string, string>(); // ronda anterior, para no repetir cuerpo
  private history = new Map<string, string[]>(); // mindId -> cuerpos por los que pasó esta ronda
  private immutableId = ""; // modos Inmutables: quién nunca cambia
  private lastImmutable = "";
  private dmPairs = new Set<string>(); // conversaciones abiertas esta noche ("a|b" ordenado)
  // Mentes expulsadas SIN revelar (votaciones intermedias de los Inmutables): el cuerpo queda como
  // fantasma y nadie sabe qué alma tenía. En el estado público no se marcan `out`; se revelan al final.
  private hiddenOut = new Set<string>();
  private initiated = new Map<string, number>(); // mindId -> chats que inició esta noche
  private dmLog: DmLog[] = [];
  private chatLog: ChatMsg[] = [];
  private answers = new Map<string, string>(); // mindId -> respuesta a La Pregunta
  private likedBy = new Map<string, Set<string>>(); // post/reply id -> mentes que dieron like
  private susBy = new Map<string, Set<string>>(); // post/reply id -> mentes que marcaron 🤨
  private lastTyping = new Map<string, number>();
  private usedQuestions = new Set<string>();
  private seq = 0;
  private guesses = new Map<string, Record<string, string>>(); // mindId -> { bodyId: mindId }
  private accusations = new Map<string, { body: string; mind: string } | null>(); // Desenmascare (null = omitir)
  private votes = new Map<string, string | null>(); // Votación / Juicio Final (null = omitir)
  private roundPts = new Map<string, number>(); // puntos acumulados en la ronda (votaciones + final)
  private earlyPts = new Map<string, number>(); // solo los de votaciones entre ciclos
  private ejections: Ejection[] = [];
  private verdict: Verdict | null = null;
  private winner: "changers" | "immutable" | null = null;
  private lastReact = new Map<string, number>();
  private lastResults: ResultsPayload | null = null;
  // Voz del lobby: orden de llegada (para las variantes) y rate limit de la señalización WebRTC.
  private joinSeq = new Map<string, number>();
  private nextJoin = 0;
  private rtcWindow = new Map<string, { start: number; count: number }>();
  private sfuPeers = new Map<string, SfuPeer>();
  // Voz en partida: las pistas se etiquetan por CUERPO. Al cambiar el reparto cambia la época y se re-suscribe todo.
  private bodyEpoch = 0;
  private callTarget = new Map<string, string>(); // 📻 mente -> mente con la que está en llamada (o llamando)
  private callPairs = new Set<string>(); // 📻 pares que ya hablaron por radio en esta fase ("a|b" ordenado)
  private callSince = new Map<string, number>(); // 📻 llamadas en curso (los dos conectados) -> desde cuándo
  private lastCalls = new Map<string, string>(); // lo último que se le mandó a cada uno en "callState"
  // 📜 Detalles de la ronda (para los resultados)
  private nightLog = new Map<number, Map<string, NightEdge>>(); // ciclo -> par de mentes -> actividad
  private threadLog: RoundDetails["threads"] = [];
  private voteLog: RoundDetails["votes"] = [];
  private authorMind = new Map<string, string>(); // post/respuesta -> mente que lo escribió
  private chatCount = new Map<string, number>();
  // 🎯 Exactitud y 🧩 ¿Quién es quién? (también en Inmutables): se hacen una sola vez por ronda
  private ratings = new Map<string, Record<string, number>>();
  private exactScores: ExactScore[] | null = null;
  private guessBlock: GuessBlock | null = null;
  private guessed = false;
  private rated = false;
  private questionCycle = 0;

  onCreate(opts: { mode?: string }) {
    this.roomId = newCode();
    this.setMode(opts?.mode && opts.mode in MODES ? (opts.mode as Mode) : "classic");
    this.state.maxPlayers = MAX_PLAYERS;
    this.state.sfu = sfuEnabled();
    this.clock.setInterval(() => this.tick(), 1000);
    this.syncMeta();

    this.onMessage("whoami", (client) => this.sendIdentity(client));

    this.onMessage("chat", (client, { text, quote }: { text: string; quote?: string }) => {
      const t = clean(text);
      const ph = this.state.phase;
      const real = ph === "LOBBY" || ph === "RESULTS"; // en partida se habla como el cuerpo
      if (!t || (!real && !this.textNow())) return;
      const me = this.pid(client);
      if (!real && !this.isActive(me)) return; // espectadores solo leen
      const fromBody = real ? me : this.bodyOf.get(me) ?? me;
      const cyc = this.state.totalCycles > 1 && ph !== "EXACT" ? ` · ciclo ${this.state.cycle}` : "";
      const tag = ph === "RESULTS" ? "🏆 Resultados" : ph === "LOBBY" ? "🛋️ Sala de espera" : `${CHAT_TAGS[ph] ?? ph}${cyc}`;
      const msg: ChatMsg = { fromBody, real, tag, text: t, ts: Date.now() };
      // Citar un cotorreo del hilo (solo de día). Se guarda una copia por si el hilo cambia en otro ciclo.
      const q = ph === "DAY" && typeof quote === "string" ? this.state.posts.find((p) => p.id === quote) : undefined;
      if (q) msg.quote = { id: q.id, body: q.body, text: q.text };
      if (!real) this.chatCount.set(me, (this.chatCount.get(me) ?? 0) + 1);
      this.chatLog.push(msg);
      if (this.chatLog.length > MAX_CHAT_LOG) this.chatLog.shift();
      this.broadcast("chat", msg);
    });

    this.onMessage("answer", (client, { text }: { text: string }) => {
      const t = clean(text).slice(0, 200);
      const me = this.pid(client);
      if (!t || this.state.phase !== "QUESTION" || !this.isActive(me)) return;
      this.answers.set(me, t);
      this.markSubmitted(me);
    });

    this.onMessage("reply", (client, { text }: { text: string }) => {
      const t = clean(text).slice(0, 200);
      const post = this.state.posts[this.state.thread];
      const me = this.pid(client);
      if (!t || this.state.phase !== "THREAD" || !post || post.replies.length >= MAX_REPLIES || !this.isActive(me)) return;
      const r = new Reply();
      r.id = `r${++this.seq}`;
      r.body = this.bodyOf.get(me) ?? me;
      this.authorMind.set(r.id, me);
      r.text = t;
      post.replies.push(r);
    });

    this.onMessage("like", (client, { id }: { id: string }) => {
      const me = this.pid(client);
      if (!["THREAD", "DAY"].includes(this.state.phase) || typeof id !== "string" || !this.isActive(me)) return;
      const target = this.findLikeable(id);
      if (!target) return;
      let set = this.likedBy.get(id);
      if (!set) this.likedBy.set(id, (set = new Set()));
      set.has(me) ? set.delete(me) : set.add(me);
      target.likes = set.size;
    });

    // 🤨 Sus: "esto no lo escribiría su dueño". Igual que el like (toggle, anónimo).
    this.onMessage("sus", (client, { id }: { id: string }) => {
      const me = this.pid(client);
      if (!["THREAD", "DAY"].includes(this.state.phase) || typeof id !== "string" || !this.isActive(me)) return;
      const target = this.findLikeable(id);
      if (!target) return;
      let set = this.susBy.get(id);
      if (!set) this.susBy.set(id, (set = new Set()));
      set.has(me) ? set.delete(me) : set.add(me);
      target.sus = set.size;
    });

    // "Escribiendo…": en el hilo y en los chats grupales se avisa a todos (por cuerpo); de noche solo a la otra punta.
    this.onMessage("typing", (client, msg: { toBody?: string }) => {
      const me = this.pid(client);
      const ph = this.state.phase;
      const now = Date.now();
      if (!this.isActive(me) || now - (this.lastTyping.get(me) ?? 0) < 800) return;
      this.lastTyping.set(me, now);
      const body = this.bodyOf.get(me) ?? me;
      if (ph === "THREAD" || (ph !== "NIGHT" && this.textNow())) return this.broadcast("typing", { body }, { except: client });
      if (ph !== "NIGHT" || typeof msg?.toBody !== "string") return;
      const target = this.mindInBody(msg.toBody);
      // Solo en conversaciones ya abiertas: no se avisa de un chat que quizá nunca empiece.
      if (!target || !this.dmPairs.has([me, target].sort().join("|"))) return;
      this.clientOf(target)?.send("typing", { body, dm: true });
    });

    // "Visto": quien tiene abierto un chat privado avisa hasta qué mensaje leyó.
    this.onMessage("seen", (client, { withBody, ts }: { withBody: string; ts: number }) => {
      const me = this.pid(client);
      if (this.state.phase !== "NIGHT" || typeof withBody !== "string" || typeof ts !== "number") return;
      const target = this.mindInBody(withBody);
      if (!target || !this.dmPairs.has([me, target].sort().join("|"))) return;
      this.clientOf(target)?.send("seen", { withBody: this.bodyOf.get(me), ts });
    });

    this.onMessage("dm", (client, { toBody, text }: { toBody: string; text: string }) => {
      const t = clean(text);
      if (!t || this.state.phase !== "NIGHT" || !this.textNow()) return;
      const me = this.pid(client);
      if (!this.isActive(me)) return;
      const myBody = this.bodyOf.get(me)!;
      const target = this.mindInBody(toBody);
      if (!target || target === me || !this.isActive(target)) return;

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
      this.logNight(me, target, (e) => e.dms++);
      client.send("dm", { fromBody: myBody, text: t, ts, withBody: toBody });
      this.clientOf(target)?.send("dm", { fromBody: myBody, text: t, ts, withBody: myBody });
      this.sendChatGraph();
    });

    // 📻 Llamada de radio: llamar a un cuerpo. Llamadas ilimitadas, pero una a la vez: llamar a otro cuelga la
    // anterior. Solo se oyen si los dos se eligieron (el otro contesta llamándote de vuelta, o rechaza).
    this.onMessage("call", (client, { toBody }: { toBody?: string }) => {
      const me = this.pid(client);
      if (!this.callsNow() || !this.isActive(me) || typeof toBody !== "string") return;
      const target = this.mindInBody(toBody);
      if (!target || target === me || !this.isActive(target)) return;
      this.callTarget.set(me, target);
      this.pushAudible();
    });

    this.onMessage("decline", (client, { fromBody }: { fromBody?: string }) => {
      const me = this.pid(client);
      const caller = typeof fromBody === "string" ? this.mindInBody(fromBody) : undefined;
      if (!this.callsNow() || !caller || this.callTarget.get(caller) !== me) return;
      this.callTarget.delete(caller);
      this.clientOf(caller)?.send("callDeclined", { byBody: this.bodyOf.get(me) });
      this.pushAudible();
    });

    this.onMessage("hangup", (client) => {
      const me = this.pid(client);
      if (!this.callTarget.delete(me)) return;
      this.pushAudible();
    });

    // 🎭 El Desenmascare: una acusación "en el cuerpo X está la mente Y", o omitir.
    this.onMessage("accuse", (client, msg: { body?: string; mind?: string; skip?: boolean }) => {
      const me = this.pid(client);
      if (this.state.phase !== "UNMASK" || !this.isActive(me)) return;
      if (msg?.skip) {
        this.accusations.set(me, null);
        return this.markSubmitted(me);
      }
      const { body, mind } = msg ?? {};
      if (typeof body !== "string" || typeof mind !== "string") return;
      if (!this.isBodyActive(body) || body === this.bodyOf.get(me) || !this.isActive(mind) || mind === me) return;
      if (body === mind && !this.canUnmaskSame()) return;
      this.accusations.set(me, { body, mind });
      this.markSubmitted(me);
    });

    // 🗳️ La Votación / ⚖️ Juicio Final: un cuerpo, o omitir.
    this.onMessage("vote", (client, msg: { body?: string; skip?: boolean }) => {
      const me = this.pid(client);
      if (!["VOTE", "FINAL_VOTE"].includes(this.state.phase) || !this.isActive(me)) return;
      if (msg?.skip) {
        this.votes.set(me, null);
        return this.markSubmitted(me);
      }
      const body = msg?.body;
      if (typeof body !== "string" || !this.isBodyActive(body) || body === this.bodyOf.get(me)) return;
      this.votes.set(me, body);
      this.markSubmitted(me);
    });

    // 🎯 Exactitud: estrellas (1–5) a cómo imitaron a cada cuerpo. Califican todos, también los espectadores,
    // menos el cuerpo en el que estás (sería calificarte a ti).
    this.onMessage("rate", (client, msg: { ratings?: Record<string, unknown> }) => {
      const me = this.pid(client);
      if (this.state.phase !== "EXACT" || !this.state.players.has(me) || !msg?.ratings || typeof msg.ratings !== "object") return;
      const clean: Record<string, number> = {};
      for (const [body, v] of Object.entries(msg.ratings)) {
        const stars = Math.round(Number(v));
        if (this.state.players.has(body) && body !== this.bodyOf.get(me) && stars >= 1 && stars <= 5) clean[body] = stars;
      }
      this.ratings.set(me, clean);
      this.markSubmitted(me);
    });

    // 👑 El host le pasa la corona a otro jugador conectado.
    this.onMessage("giveHost", (client, { to }: { to?: string }) => {
      if (!this.isHost(client) || typeof to !== "string" || to === this.state.hostId || !this.state.players.get(to)?.connected) return;
      this.state.hostId = to;
      this.broadcast("hostChanged", { id: to });
    });

    // Reacciones en vivo sobre tarjetas (no cuentan como voto).
    // El destino lo decide el server: votando, sobre tu propio cuerpo; en el anuncio, sobre el expulsado (o al aire si no salió nadie).
    this.onMessage("react", (client, { emoji }: { emoji: string }) => {
      const me = this.pid(client);
      const ph = this.state.phase;
      if (!["UNMASK", "VOTE", "FINAL_VOTE", "VERDICT"].includes(ph) || !this.isActive(me) || !REACTIONS.includes(emoji)) return;
      const now = Date.now();
      if (now - (this.lastReact.get(me) ?? 0) < 150) return;
      this.lastReact.set(me, now);
      const target = ph === "VERDICT"
        ? (this.verdict?.outcome === "ejected" && this.verdict.bodyId ? this.verdict.bodyId : "verdict")
        : this.bodyOf.get(me) ?? me;
      this.broadcast("reaction", { target, emoji });
    });

    // 🎙️ Voz del lobby: tipo de voz y micrófono. Es solo un perfil: se acepta en cualquier fase.
    this.onMessage("voiceProfile", (client, msg: { voice?: string; micOn?: boolean }) => {
      const p = this.state.players.get(this.pid(client));
      if (!p || !msg || typeof msg !== "object") return;
      // En partida no se toca: ver quién se mutea (o cambia de voz) justo cuando un cuerpo calla delataría su mente.
      if (this.state.phase !== "LOBBY") return;
      if (typeof msg.voice === "string" && VOICES.includes(msg.voice)) p.voice = msg.voice;
      if (typeof msg.micOn === "boolean") p.micOn = msg.micOn && !["", "listen"].includes(p.voice);
      this.assignVoiceVariants();
      console.log(`[voz] ${this.roomId}: ${p.name} → ${p.voice || "sin voz"}${p.micOn ? " 🎙️" : ""}`);
    });

    // Señalización WebRTC (malla P2P del lobby): el server solo reenvía ofertas, respuestas e ICE.
    this.onMessage("rtc", (client, msg: { to?: string; data?: Record<string, unknown> }) => {
      const me = this.pid(client);
      const to = msg?.to;
      const data = msg?.data;
      if (this.state.phase !== "LOBBY" || typeof to !== "string" || to === me || !data || typeof data !== "object") return;
      const drop = (why: string) => {
        rtcStats.dropped++;
        console.warn(`[voz] ${this.roomId}: señal de ${this.state.players.get(me)?.name ?? me} descartada (${why})`);
      };
      if (!this.state.players.get(to)?.connected || !this.state.players.has(me)) return drop("destino desconectado");
      if (!("description" in data || "candidate" in data || "hello" in data)) return drop("formato");
      if (JSON.stringify(data).length > RTC_MAX_BYTES) return drop("muy grande");
      const now = Date.now();
      const w = this.rtcWindow.get(me);
      if (!w || now - w.start >= 1000) this.rtcWindow.set(me, { start: now, count: 1 });
      else if (++w.count > RTC_PER_SECOND) return w.count === RTC_PER_SECOND + 1 ? drop("rate limit") : undefined;
      const target = this.clientOf(to);
      if (!target) return drop("sin conexión");
      target.send("rtc", { from: me, data });
      rtcStats.relayed++;
    });

    // Voz por Cloudflare SFU: el navegador pide cada operación y el server la hace con el secreto de la app.
    // Cada petición lleva un `rid` y se contesta con el mismo `rid` (ok o error).
    this.onMessage("sfu", (client, msg: SfuMsg) => { void this.onSfu(client, msg ?? {}); });

    this.onMessage("settings", (client, patch: Partial<Record<keyof Settings, number | string | boolean>>) => {
      if (!this.isHost(client) || this.state.phase !== "LOBBY" || !patch || typeof patch !== "object") return;
      const s = this.state.settings;
      const bool = (k: keyof Settings) => typeof patch[k] === "boolean";
      if (typeof patch.mode === "string" && patch.mode in MODES) this.setMode(patch.mode as Mode);
      if ("cycles" in patch) s.cycles = clamp(patch.cycles, 0, 5, s.cycles);
      // 0 apaga la fase (menos la votación final)
      if ("questionSeconds" in patch) s.questionSeconds = clamp(patch.questionSeconds, 0, 180, s.questionSeconds);
      if ("threadSeconds" in patch) s.threadSeconds = clamp(patch.threadSeconds, 0, 120, s.threadSeconds);
      if ("daySeconds" in patch) s.daySeconds = clamp(patch.daySeconds, 0, 600, s.daySeconds);
      if ("nightSeconds" in patch) s.nightSeconds = clamp(patch.nightSeconds, 0, 600, s.nightSeconds);
      if ("guessSeconds" in patch) s.guessSeconds = clamp(patch.guessSeconds, 20, 300, s.guessSeconds);
      if ("voteSeconds" in patch) s.voteSeconds = clamp(patch.voteSeconds, 15, 180, s.voteSeconds);
      if ("chatsPerNight" in patch) s.chatsPerNight = clamp(patch.chatsPerNight, 0, 7, s.chatsPerNight);
      if ("maxEjections" in patch) s.maxEjections = clamp(patch.maxEjections, 0, MAX_PLAYERS, s.maxEjections);
      if (typeof patch.earlyVote === "boolean") s.earlyVote = patch.earlyVote;
      if (typeof patch.unmaskSame === "boolean") s.unmaskSame = patch.unmaskSame && s.mode === "classic";
      if ("voiceWalkie" in patch) s.voiceWalkie = clamp(patch.voiceWalkie, 0, 3, s.voiceWalkie);
      if (bool("voicePhases")) s.voicePhases = !!patch.voicePhases && sfuEnabled();
      if (bool("voiceText")) s.voiceText = !!patch.voiceText;
      if (typeof patch.nightMode === "string" && ["radio", "chat", "both"].includes(patch.nightMode)) s.nightMode = patch.nightMode as NightMode;
      if (bool("splitRadio")) s.splitRadio = !!patch.splitRadio;
      if ("radioSeconds" in patch) s.radioSeconds = clamp(patch.radioSeconds, 15, 600, s.radioSeconds);
      if (bool("voteChat")) s.voteChat = !!patch.voteChat;
      if (bool("voteVoice")) s.voteVoice = !!patch.voteVoice;
      if (bool("immGuess")) s.immGuess = !!patch.immGuess && isImmutableMode(s.mode);
      if (bool("exactPhase")) s.exactPhase = !!patch.exactPhase;
      if (bool("exactChat")) s.exactChat = !!patch.exactChat;
      if ("exactSeconds" in patch) s.exactSeconds = clamp(patch.exactSeconds, 20, 180, s.exactSeconds);
      if ("music" in patch) s.music = clamp(patch.music, 0, 3, s.music);
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
      if (!p || !this.isActive(p.id)) return;
      p.skipVote = !p.skipVote;
      this.checkSkipVotes();
    });

    this.onMessage("guesses", (client, { guesses }: { guesses: Record<string, string> }) => {
      const me = this.pid(client);
      if (this.state.phase !== "GUESS" || !this.isActive(me)) return;
      this.guesses.set(me, typeof guesses === "object" && guesses ? guesses : {});
      this.markSubmitted(me);
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
    this.joinSeq.set(p.id, this.nextJoin++);
    this.assignVoiceVariants();
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
    this.sfuDrop(pid); // la conexión nueva vuelve a publicar
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

    this.sfuDrop(id);
    if (this.state.phase === "LOBBY") {
      this.state.players.delete(id);
      this.joinSeq.delete(id);
      this.rtcWindow.delete(id);
      this.assignVoiceVariants();
      this.reassignHost();
      this.syncMeta();
      return;
    }

    // En partida: mantenemos al jugador (su cuerpo sigue existiendo) y esperamos reconexión.
    p.connected = false;
    p.skipVote = false;
    this.reassignHost();
    this.checkSkipVotes();
    this.checkAllSubmitted();
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
    const s = this.state.settings;
    s.mode = mode;
    this.state.minPlayers = minPlayersFor(mode);
    // valores por defecto que dependen del modo
    s.voteSeconds = isImmutableMode(mode) ? 45 : 30;
    s.maxEjections = isImmutableMode(mode) ? 0 : 1;
    if (mode !== "classic") s.unmaskSame = false;
    // En El No Cambiante los cambiantes cambian una sola vez: adivinar quién es quién tiene más sentido.
    s.immGuess = mode === "still";
  }

  private startRound() {
    const s = this.state.settings;
    this.state.round++;
    this.state.cycle = 0;
    this.state.totalCycles = s.cycles > 0 ? s.cycles : autoCycles(s.mode, this.state.players.size, s.earlyVote);
    this.guesses.clear();
    this.chatLog = [];
    this.lastResults = null;
    this.roundPts.clear();
    this.earlyPts.clear();
    this.ejections = [];
    this.hiddenOut.clear();
    this.verdict = null;
    this.winner = null;
    this.nightLog.clear();
    this.threadLog = [];
    this.voteLog = [];
    this.authorMind.clear();
    this.chatCount.clear();
    this.ratings.clear();
    this.exactScores = null;
    this.guessBlock = null;
    this.guessed = false;
    this.rated = false;
    this.state.posts.clear();
    this.state.question = "";
    for (const p of this.state.players.values()) {
      p.submitted = false;
      p.out = false;
      p.bodyOut = false;
    }
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
    if (hasRadioPhase(s, sfuEnabled()) && s.radioSeconds > 0) list.push("RADIO");
    return list;
  }

  /**
   * 🧳 → [❓ → 🦜 → ☀️ → 🌙 → (📻) → (votación entre ciclos) → (re-cambio en El Inmutable)] × ciclos
   *   → votación final → (🎯 Exactitud) → 🏆
   * La votación entre ciclos no ocurre en el último ciclo: a ese le sigue la votación final.
   * En los Inmutables, con 🧩 activo, antes del ⚖️ Juicio Final se adivina quién es quién.
   */
  private advance() {
    const ph = this.state.phase;
    if (ph === "THREAD" && this.state.thread < this.state.posts.length - 1) {
      this.state.thread++;
      this.setPhase("THREAD", this.state.settings.threadSeconds);
      return;
    }
    // 📻 Se cortan las llamadas antes de que cambie el ciclo (o el reparto): su duración queda en esta noche.
    if (PRIVATE_PHASES.includes(ph)) {
      this.callTarget.clear();
      this.trackCalls();
    }
    switch (ph) {
      case "SWAP":
        if (this.state.cycle === 0) this.state.cycle = 1;
        return this.goTo(this.cyclePhases(), 0);
      case "UNMASK":
        return this.showVerdict(this.resolveUnmaskPhase());
      case "VOTE":
        return this.showVerdict(this.resolveVotePhase(false));
      case "FINAL_VOTE":
        return this.showVerdict(this.resolveVotePhase(true));
      case "VERDICT":
        if (this.winner || this.verdict?.kind === "FINAL_VOTE") return this.afterFinal();
        return this.nextCycle();
      case "GUESS":
        this.guessBlock = this.scoreGuesses();
        this.guessed = true;
        // Inmutables: después de adivinar viene el Juicio Final (salvo que la partida ya haya terminado).
        if (isImmutableMode(this.state.settings.mode) && !this.winner) return this.startFinalVote();
        return this.afterFinal();
      case "EXACT":
        this.exactScores = scoreExact(this.ratings, this.occupants());
        for (const e of this.exactScores) this.addPts(e.mindId, e.points, false);
        this.rated = true;
        return this.afterFinal();
      case "LOBBY":
      case "RESULTS":
        return;
      default: {
        const list = this.cyclePhases();
        return this.goTo(list, list.indexOf(ph) + 1);
      }
    }
  }

  private goTo(list: Phase[], i: number): void {
    if (i >= list.length) return this.endOfCycle();
    const s = this.state.settings;
    switch (list[i]) {
      case "QUESTION": {
        this.snapshotThread();
        this.questionCycle = this.state.cycle;
        this.answers.clear();
        this.likedBy.clear();
        this.susBy.clear();
        this.state.posts.clear();
        this.state.question = this.pickQuestion();
        this.resetSubmitted();
        return this.setPhase("QUESTION", s.questionSeconds);
      }
      case "THREAD": {
        const answered = shuffle([...this.answers.entries()].filter(([m]) => this.isActive(m)));
        if (answered.length === 0) return this.goTo(list, i + 1); // nadie respondió: no hay hilo
        for (const [mind, text] of answered) {
          const post = new Post();
          post.id = `p${++this.seq}`;
          post.body = this.bodyOf.get(mind) ?? mind;
          post.text = text;
          this.authorMind.set(post.id, mind);
          this.state.posts.push(post);
        }
        this.state.thread = 0;
        return this.setPhase("THREAD", s.threadSeconds);
      }
      case "DAY":
        return this.setPhase("DAY", s.daySeconds);
      case "NIGHT":
        return this.startNight(s.nightSeconds);
      case "RADIO":
        this.callTarget.clear();
        this.callPairs.clear();
        if (!this.nightLog.has(this.state.cycle)) this.nightLog.set(this.state.cycle, new Map());
        return this.setPhase("RADIO", s.radioSeconds);
    }
  }

  private endOfCycle() {
    const s = this.state.settings;
    const last = this.state.cycle >= this.state.totalCycles;
    if (last) return this.enterFinal();
    if (s.earlyVote && this.ejectionsLeft() && this.activeIds().length >= 3) {
      this.resetSubmitted();
      this.accusations.clear();
      this.votes.clear();
      return this.setPhase(isImmutableMode(s.mode) ? "VOTE" : "UNMASK", s.voteSeconds);
    }
    this.nextCycle();
  }

  private nextCycle() {
    this.state.cycle++;
    if (this.state.settings.mode === "immutable") {
      this.reswap();
      this.setPhase("SWAP", SWAP_SECONDS);
      this.clients.forEach((c) => this.sendIdentity(c));
      return;
    }
    this.goTo(this.cyclePhases(), 0);
  }

  private enterFinal() {
    const s = this.state.settings;
    if (isImmutableMode(s.mode) && !s.immGuess) return this.startFinalVote();
    this.startGuess();
  }

  private startGuess() {
    this.resetSubmitted();
    this.setPhase("GUESS", this.state.settings.guessSeconds);
  }

  private startFinalVote() {
    this.resetSubmitted();
    this.votes.clear();
    this.setPhase("FINAL_VOTE", this.state.settings.guessSeconds);
  }

  /** La votación final ya se resolvió (o la partida terminó antes): lo que falte de 🧩 y 🎯, y a los resultados. */
  private afterFinal() {
    const s = this.state.settings;
    const imm = isImmutableMode(s.mode);
    if (imm && s.immGuess && !this.guessed) return this.startGuess();
    if (s.exactPhase && !this.rated) {
      this.resetSubmitted();
      this.ratings.clear();
      return this.setPhase("EXACT", s.exactSeconds);
    }
    if (imm) return this.finishImmutable();
    this.finishGuess();
  }

  private ejectionsLeft() {
    const max = this.state.settings.maxEjections;
    return max === 0 || this.ejections.length < max;
  }

  private showVerdict(v: Verdict) {
    this.verdict = v;
    this.broadcast("verdict", v);
    this.setPhase("VERDICT", VERDICT_SECONDS);
  }

  // ---------------- votaciones ----------------

  private resolveUnmaskPhase(): Verdict {
    this.logBallots("UNMASK");
    const truth: Record<string, string> = {};
    for (const [m, b] of this.bodyOf) if (this.isActive(m)) truth[b] = m;
    const r = resolveUnmask({
      accusations: this.accusations, truth, activeCount: this.activeIds().length, allowSame: this.canUnmaskSame(),
    });
    if (!r) return { kind: "UNMASK", outcome: "none" };
    const same = r.bodyId === r.mindId;
    this.eject("UNMASK", r.bodyId, r.mindId);
    this.addPts(r.mindId, same ? POINTS.unmaskedSame : POINTS.unmasked, true);
    for (const a of r.correct) this.addPts(a, same ? POINTS.unmaskSame : POINTS.unmask, true);
    return { kind: "UNMASK", outcome: "ejected", bodyId: r.bodyId, mindId: r.mindId, wasSame: same };
  }

  private resolveVotePhase(final: boolean): Verdict {
    const kind = final ? "FINAL_VOTE" : "VOTE";
    this.logBallots(kind);
    const { top, reason, tally } = resolvePlurality(this.votes);
    if (!top) {
      if (final) this.winImmutable();
      else this.addPts(this.immutableId, POINTS.immutableSurvives, true);
      return { kind, tally, outcome: "none", reason, winner: this.winner ?? undefined };
    }
    const mind = this.mindInBody(top)!;
    const voters = [...this.votes.entries()].filter(([, b]) => b === top).map(([v]) => v);
    // En una votación intermedia, si sale un cambiante NO se revela qué alma tenía: revelarla descartaría
    // a otra mente que seguro no está en su cuerpo. El cuerpo queda como fantasma.
    const ghost = !final && mind !== this.immutableId;
    this.eject(kind, top, mind, ghost);
    if (mind === this.immutableId) {
      this.winner = "changers";
      for (const p of this.state.players.values()) if (p.id !== this.immutableId) this.addPts(p.id, POINTS.changersWin, false);
      for (const v of voters) this.addPts(v, POINTS.votedImmutable, false);
      return { kind, tally, outcome: "ejected", bodyId: top, mindId: mind, wasImmutable: true, winner: "changers" };
    }
    // Penaliza a los cambiantes que votaron mal; para el Inmutable expulsar cambiantes es el objetivo.
    for (const v of voters) if (v !== this.immutableId) this.addPts(v, POINTS.votedChanger, !final);
    this.addPts(this.immutableId, POINTS.immutableEjects, !final);
    if (!final) this.addPts(this.immutableId, POINTS.immutableSurvives, true);
    if (final || this.activeIds().length <= 2) this.winImmutable();
    if (ghost && this.winner) this.revealHidden(); // la partida terminó: ya se puede saber
    return {
      kind, tally, outcome: "ejected", bodyId: top, mindId: ghost && !this.winner ? undefined : mind,
      wasImmutable: false, ghost: ghost && !this.winner, winner: this.winner ?? undefined,
    };
  }

  private winImmutable() {
    if (this.winner) return;
    this.winner = "immutable";
    this.addPts(this.immutableId, POINTS.immutableWins, false);
  }

  private eject(kind: Ejection["kind"], bodyId: string, mindId: string, hidden = false) {
    const mind = this.state.players.get(mindId);
    const body = this.state.players.get(bodyId);
    if (mind) {
      if (hidden) this.hiddenOut.add(mindId);
      else mind.out = true;
      mind.skipVote = false;
    }
    if (body) body.bodyOut = true;
    this.ejections.push({ cycle: this.state.cycle, kind, bodyId, mindId, wasImmutable: mindId === this.immutableId });
    // La mente expulsada se entera en privado de que ahora es espectadora.
    const c = this.clientOf(mindId);
    if (c && hidden) this.sendIdentity(c);
  }

  /** Al terminar la partida, los fantasmas pasan a ser espectadores públicos (ya no hay nada que ocultar). */
  private revealHidden() {
    for (const id of this.hiddenOut) {
      const p = this.state.players.get(id);
      if (p) p.out = true;
    }
    this.hiddenOut.clear();
  }

  /** Espectadores: quién habla con quién esta noche (por cuerpo; mensajes + 📻 llamadas), sin el contenido. */
  private chatGraph() {
    const night = this.nightLog.get(this.state.cycle);
    return [...(night?.values() ?? [])].map((e) => ({ a: e.aBody, b: e.bBody, count: e.dms + e.calls, last: e.last }));
  }

  private sendChatGraph() {
    if (!PRIVATE_PHASES.includes(this.state.phase)) return;
    const graph = this.chatGraph();
    for (const [pid, c] of this.clientOfPid) if (!this.isActive(pid)) c.send("chatGraph", graph);
  }

  private addPts(pid: string, pts: number, early: boolean) {
    if (!pid) return;
    this.roundPts.set(pid, (this.roundPts.get(pid) ?? 0) + pts);
    if (early) this.earlyPts.set(pid, (this.earlyPts.get(pid) ?? 0) + pts);
    // En los Inmutables el marcador público se actualiza recién al final: ver quién sumó tras una
    // votación delataría al Inmutable.
    if (isImmutableMode(this.state.settings.mode)) return;
    const p = this.state.players.get(pid);
    if (p) p.score += pts;
  }

  // ---------------- helpers de fase ----------------

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
    this.callTarget.clear();
    this.callPairs.clear();
    this.dmPairs.clear();
    this.initiated.clear();
    this.dmLog = [];
    const s = this.state.settings;
    this.state.chatLimit = s.chatsPerNight > 0 ? s.chatsPerNight : autoChats(this.activeIds().length);
    if (!this.nightLog.has(this.state.cycle)) this.nightLog.set(this.state.cycle, new Map()); // 📜 aunque nadie hable
    this.setPhase("NIGHT", seconds);
    this.sendChatGraph();
  }

  private setPhase(phase: Phase, seconds: number) {
    const changed = this.state.phase !== phase;
    // Sin voz en partida, al salir del lobby la voz se apaga: cada cliente cierra sus conexiones y el server olvida las sesiones.
    if (changed && this.state.phase === "LOBBY" && !this.voiceInGame()) for (const id of [...this.sfuPeers.keys()]) this.sfuDrop(id);
    if (changed && !PRIVATE_PHASES.includes(phase)) this.callTarget.clear();
    this.state.phase = phase;
    this.state.timer = seconds;
    for (const p of this.state.players.values()) p.skipVote = false;
    if (changed) this.syncMeta();
    if (changed) this.pushAudible();
  }

  private resetSubmitted() {
    for (const p of this.state.players.values()) p.submitted = false;
  }

  private markSubmitted(pid: string) {
    const p = this.state.players.get(pid);
    if (p) p.submitted = true;
    this.checkAllSubmitted();
  }

  private checkSkipVotes() {
    if (!SKIPPABLE.includes(this.state.phase)) return;
    const voters = [...this.state.players.values()].filter((p) => p.connected && this.isActive(p.id));
    const votes = voters.filter((p) => p.skipVote).length;
    if (votes > 0 && votes >= skipNeeded(voters.length)) {
      this.broadcast("skipped", { by: "vote" });
      this.advance();
    }
  }

  /** Si todos los activos conectados ya respondieron / votaron, se avanza sin esperar el reloj. */
  private checkAllSubmitted() {
    if (!SUBMIT_PHASES.includes(this.state.phase)) return;
    const everyone = this.state.phase === "EXACT"; // en 🎯 Exactitud califican también los espectadores
    const pending = [...this.state.players.values()].some((p) => p.connected && (everyone || this.isActive(p.id)) && !p.submitted);
    if (!pending) this.advance();
  }

  private isActive(pid: string) {
    const p = this.state.players.get(pid);
    return !!p && !p.out && !this.hiddenOut.has(pid);
  }

  private isBodyActive(bodyId: string) {
    const p = this.state.players.get(bodyId);
    return !!p && !p.bodyOut;
  }

  private activeIds() {
    return [...this.state.players.values()].filter((p) => this.isActive(p.id)).map((p) => p.id);
  }

  private canUnmaskSame() {
    return this.state.settings.mode === "classic" && this.state.settings.unmaskSame;
  }

  // ---------------- cuerpos ----------------

  /** Reparte `minds` sobre `bodies`: nadie queda en `avoid(m)`; si se puede, tampoco en `soft(m)`. */
  private derange(minds: string[], bodies: string[], avoid: (m: string) => string | undefined, soft: (m: string) => string | undefined) {
    const bad = (next: string[], strict: boolean) =>
      next.some((b, i) => b === avoid(minds[i]) || (strict && b === soft(minds[i])));
    let next = shuffle(bodies);
    for (let tries = 0; tries < 5000 && bad(next, tries < 2000); tries++) next = shuffle(bodies);
    minds.forEach((m, i) => this.bodyOf.set(m, next[i]));
  }

  /**
   * El cambio al empezar la ronda.
   * Clásico: cambian entre 2 y N-2. Todos: todos. Inmutables: todos menos el Inmutable.
   */
  private assignBodies() {
    const all = shuffle([...this.state.players.keys()]);
    const mode = this.state.settings.mode;
    this.bodyOf.clear();
    this.history.clear();
    all.forEach((m) => this.bodyOf.set(m, m));
    this.immutableId = "";

    let movers: string[];
    if (isImmutableMode(mode)) {
      const pool = all.length > 1 ? all.filter((m) => m !== this.lastImmutable) : all;
      this.immutableId = pool[0] ?? "";
      this.lastImmutable = this.immutableId;
      movers = all.filter((m) => m !== this.immutableId);
    } else {
      movers = all.slice(0, swapCount(mode, all.length));
    }
    if (movers.length >= 2) this.derange(movers, movers, (m) => m, (m) => this.lastBodyOf.get(m));
    this.bodyEpoch++;
    this.lastBodyOf = new Map(this.bodyOf);
    for (const m of all) this.history.set(m, [this.bodyOf.get(m)!]);
  }

  /** El Inmutable: entre ciclos los cambiantes activos vuelven a cambiar entre los cuerpos que siguen en juego. */
  private reswap() {
    const movers = shuffle(this.activeIds().filter((m) => m !== this.immutableId));
    const bodies = movers.map((m) => this.bodyOf.get(m)!);
    if (movers.length >= 2) {
      const current = new Map(movers.map((m) => [m, this.bodyOf.get(m)!]));
      this.derange(movers, bodies, (m) => current.get(m), () => undefined);
    }
    for (const m of movers) this.history.get(m)?.push(this.bodyOf.get(m)!);
    this.bodyEpoch++;
  }

  // ---------------- resultados ----------------

  /**
   * 🧩 ¿Quién es quién?: se puntúa sobre los cuerpos y mentes que siguen en juego. Suma los puntos al momento
   * (en los Inmutables quedan guardados hasta el final, como el resto).
   */
  private scoreGuesses(): GuessBlock {
    const minds = [...this.bodyOf.keys()];
    const active = minds.filter((m) => this.isActive(m));
    const rivals = active.length - 1;
    const classic = this.state.settings.mode === "classic";

    // Normalizamos: en clásico, un cuerpo sin marcar = "no cambió" (su dueño).
    const norm: Record<string, Record<string, string>> = {};
    for (const m of active) {
      const raw = this.guesses.get(m) ?? {};
      const g: Record<string, string> = {};
      for (const o of active) {
        const b = this.bodyOf.get(o)!;
        if (b === this.bodyOf.get(m)) continue;
        const v = typeof raw[b] === "string" && this.isActive(raw[b]) ? raw[b] : "";
        g[b] = v || (classic ? b : "");
      }
      norm[m] = g;
    }

    const results: RoundResult[] = minds.map((m) => {
      const myBody = this.bodyOf.get(m)!;
      const swapped = myBody !== m;
      const early = this.earlyPts.get(m) ?? 0;
      if (!this.isActive(m)) {
        return { mindId: m, bodyId: myBody, swapped, out: true, hits: 0, sameHits: 0, guessedBy: 0, fooled: 0, bonus: null, early, exact: 0, points: early };
      }
      let hits = 0;
      let sameHits = 0;
      for (const o of active) {
        if (o === m) continue;
        const b = this.bodyOf.get(o)!;
        if (norm[m][b] === o) b === o ? sameHits++ : hits++;
      }
      const others = active.filter((o) => o !== m);
      const guessedBy = others.filter((o) => norm[o][myBody] === m).length;
      const fooled = swapped ? 0 : others.filter((o) => norm[o][myBody] && norm[o][myBody] !== m).length;
      const bonus = swapped
        ? (guessedBy < rivals * 0.5 ? "stealth" : null)
        : (rivals > 0 && fooled >= rivals * 0.5 ? "decoy" : null);
      const final = hits * POINTS.guessSwap + sameHits * POINTS.guessSame + (bonus ? POINTS.bonus : 0);
      this.addPts(m, final, false);
      return { mindId: m, bodyId: myBody, swapped, out: false, hits, sameHits, guessedBy, fooled, bonus, early, exact: 0, points: early + final };
    });
    return { results, guesses: norm };
  }

  /** Clásico / Todos: resultados de ¿Quién es quién? (+ 🎯 Exactitud si estuvo). */
  private finishGuess() {
    const block = this.guessBlock ?? this.scoreGuesses();
    const exact = new Map((this.exactScores ?? []).map((e) => [e.mindId, e.points]));
    const results = block.results.map((r) => ({ ...r, exact: exact.get(r.mindId) ?? 0, points: r.points + (exact.get(r.mindId) ?? 0) }));
    for (const p of this.state.players.values()) p.lastPoints = this.roundPts.get(p.id) ?? 0;
    this.lastResults = {
      family: "guess", mode: this.state.settings.mode, results, guesses: block.guesses, ejections: this.ejections,
      exact: this.exactScores, details: this.details(),
    };
    this.broadcast("results", this.lastResults);
    this.setPhase("RESULTS", 0);
  }

  private finishImmutable() {
    if (!this.winner) this.winImmutable();
    this.revealHidden();
    for (const p of this.state.players.values()) {
      p.lastPoints = this.roundPts.get(p.id) ?? 0;
      p.score += p.lastPoints;
    }
    this.lastResults = {
      family: "immutable",
      mode: this.state.settings.mode,
      immutableId: this.immutableId,
      winner: this.winner!,
      bodies: Object.fromEntries(this.bodyOf),
      history: Object.fromEntries(this.history),
      ejections: this.ejections,
      points: Object.fromEntries([...this.state.players.keys()].map((id) => [id, this.roundPts.get(id) ?? 0])),
      guess: this.guessBlock,
      exact: this.exactScores,
      details: this.details(),
    };
    this.broadcast("results", this.lastResults);
    this.setPhase("RESULTS", 0);
  }

  /** Cuerpo -> mente que tiene adentro ahora. */
  private occupants() {
    return Object.fromEntries([...this.bodyOf].map(([m, b]) => [b, m]));
  }

  // ---------------- 📜 detalles de la ronda ----------------

  /** Suma actividad privada (mensajes, llamadas) entre dos mentes en el ciclo actual. */
  private logNight(a: string, b: string, fn: (e: NightEdge) => void) {
    let night = this.nightLog.get(this.state.cycle);
    if (!night) this.nightLog.set(this.state.cycle, (night = new Map()));
    const [x, y] = [a, b].sort();
    const key = `${x}|${y}`;
    let e = night.get(key);
    if (!e) {
      e = { aMind: x, bMind: y, aBody: this.bodyOf.get(x) ?? x, bBody: this.bodyOf.get(y) ?? y, dms: 0, calls: 0, callSec: 0, last: 0 };
      night.set(key, e);
    }
    fn(e);
    e.last = Date.now();
    this.sendChatGraph();
  }

  /** Guarda el hilo de Cotorra del ciclo (con quién escribió qué de verdad) antes de que se borre. */
  private snapshotThread() {
    if (this.state.posts.length === 0) return;
    const entry = (p: Post | Reply) => ({ id: p.id, body: p.body, mind: this.authorMind.get(p.id) ?? p.body, text: p.text, likes: p.likes, sus: p.sus });
    this.threadLog.push({
      cycle: this.questionCycle,
      question: this.state.question,
      posts: this.state.posts.map((p) => ({ ...entry(p), replies: p.replies.map(entry) })),
    });
  }

  /** Quién votó qué (se revela al final). */
  private logBallots(kind: Ejection["kind"]) {
    const ballots = kind === "UNMASK"
      ? [...this.accusations].map(([v, a]) => ({ voter: v, voterBody: this.bodyOf.get(v) ?? v, body: a?.body ?? null, mind: a?.mind }))
      : [...this.votes].map(([v, b]) => ({ voter: v, voterBody: this.bodyOf.get(v) ?? v, body: b }));
    this.voteLog.push({ cycle: this.state.cycle, kind, ballots });
  }

  private details(): RoundDetails {
    this.snapshotThread();
    this.state.posts.clear(); // ya quedó guardado: que no se guarde dos veces
    return {
      nights: [...this.nightLog].map(([cycle, edges]) => ({ cycle, edges: [...edges.values()] })),
      threads: this.threadLog,
      votes: this.voteLog,
      chat: Object.fromEntries(this.chatCount),
      history: Object.fromEntries(this.history),
    };
  }

  private backToLobby() {
    this.hiddenOut.clear();
    for (const p of [...this.state.players.values()]) {
      if (!p.connected) {
        this.state.players.delete(p.id);
        this.joinSeq.delete(p.id);
        this.pendingReconnect.get(p.id)?.reject(new Error("removed"));
        this.pendingReconnect.delete(p.id);
      } else {
        p.submitted = false;
        p.out = false;
        p.bodyOut = false;
      }
    }
    this.bodyOf.clear();
    this.guesses.clear();
    this.dmLog = [];
    this.lastResults = null;
    this.verdict = null;
    this.state.cycle = 0;
    this.state.posts.clear();
    this.state.question = "";
    this.assignVoiceVariants();
    this.setPhase("LOBBY", 0);
    this.reassignHost();
    this.clients.forEach((c) => this.sendIdentity(c));
  }

  // ---------------- voz por SFU ----------------

  private async onSfu(client: Client, msg: SfuMsg) {
    const me = this.pid(client);
    const reply = (data: object) => client.send("sfu", { rid: msg.rid, ...data });
    const op = msg.op;
    // "config" se puede pedir siempre: dice si hay SFU y con qué ICE conectarse.
    if (op === "config") return reply({ ok: true, sfu: sfuEnabled(), iceServers: sfuEnabled() ? await iceServers() : [] });
    if (!sfuEnabled()) return reply({ error: "El SFU no está configurado" });
    const voiceNow = this.state.phase === "LOBBY" || this.voiceInGame();
    // Cerrar o salir con la voz ya apagada no es un error: las sesiones ya se soltaron.
    if ((op === "leave" || op === "close") && !voiceNow) return reply({ ok: true });
    if (!voiceNow || !this.state.players.has(me)) return reply({ error: "La voz no está activa en esta fase" });
    const peer = this.sfuPeers.get(me) ?? { ready: false };
    this.sfuPeers.set(me, peer);
    const who = this.state.players.get(me)?.name ?? me;
    rtcStats.sfuCalls++;
    try {
      switch (op) {
        case "publish": {
          if (msg.sdp?.type !== "offer" || typeof msg.sdp.sdp !== "string" || typeof msg.mid !== "string") throw new Error("oferta inválida");
          if (peer.pub) this.sfuClosePub(peer);
          const session = await sfu.newSession();
          const r = await sfu.push(session, msg.sdp, msg.mid, VOICE_TRACK);
          const t = r.tracks?.[0];
          if (t?.errorCode || !r.sessionDescription) throw new Error(`no se pudo publicar: ${t?.errorCode ?? "sin respuesta"} ${t?.errorDescription ?? ""}`);
          Object.assign(peer, { pub: session, pubMid: msg.mid, ready: false });
          console.log(`[voz] ${this.roomId}: ${who} publica su voz en el SFU`);
          return reply({ ok: true, sdp: r.sessionDescription });
        }
        case "ready": // el navegador ya está conectado y mandando audio: los demás se pueden suscribir
          if (!peer.pub) throw new Error("no hay publicación");
          peer.ready = true;
          this.pushAudible();
          return reply({ ok: true });
        case "subscribe": {
          peer.sub = await sfu.newSession();
          peer.sent = undefined;
          return reply({ ok: true, ...this.audibleFor(me) });
        }
        case "pull": {
          // `pids` son ETIQUETAS (cuerpos en partida). Solo se entrega lo que este jugador puede oír ahora.
          if (!peer.sub) throw new Error("no hay sesión de recepción");
          const allowed = new Set(this.audibleFor(me).bodies);
          const labels = (Array.isArray(msg.pids) ? msg.pids : []).filter((l) => allowed.has(l));
          if (labels.length === 0) return reply({ ok: true, tracks: [] });
          const bySession = new Map(labels.map((l) => [this.sfuPeers.get(this.voiceMind(l))!.pub!, l]));
          const r = await sfu.pull(peer.sub, [...bySession.keys()].map((sessionId) => ({ sessionId, trackName: VOICE_TRACK })));
          const tracks = (r.tracks ?? []).map((t) => ({
            pid: bySession.get(t.sessionId ?? "") ?? "", mid: t.mid, error: t.errorCode,
          }));
          const failed = tracks.filter((t) => t.error);
          if (failed.length) console.warn(`[voz] ${this.roomId}: ${who} no pudo recibir a ${failed.map((t) => `${this.state.players.get(t.pid)?.name ?? t.pid} (${t.error})`).join(", ")}`);
          return reply({ ok: true, tracks, sdp: r.sessionDescription, renegotiate: !!r.requiresImmediateRenegotiation });
        }
        case "renegotiate":
          if (!peer.sub || msg.sdp?.type !== "answer" || typeof msg.sdp.sdp !== "string") throw new Error("respuesta inválida");
          await sfu.renegotiate(peer.sub, msg.sdp);
          return reply({ ok: true });
        case "close": {
          const mids = (Array.isArray(msg.mids) ? msg.mids : []).filter((m) => typeof m === "string");
          if (peer.sub && mids.length) await sfu.close(peer.sub, mids);
          return reply({ ok: true });
        }
        case "leave": // el jugador sale de la voz (o pasa a solo escuchar)
          this.sfuDrop(me);
          return reply({ ok: true });
        default:
          throw new Error(`operación desconocida: ${op}`);
      }
    } catch (e) {
      rtcStats.sfuErrors++;
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[voz] ${this.roomId}: error SFU (${op}) de ${who}: ${message}`);
      return reply({ error: message });
    }
  }

  private voiceInGame() {
    return this.state.settings.voicePhases && sfuEnabled();
  }

  /** Chat escrito y voz de la fase actual (en partida). */
  private channels() {
    return channels(this.state.settings, this.state.phase, sfuEnabled());
  }
  private textNow() {
    return this.channels().text;
  }
  /** 📻 Llamadas de radio: de noche (juntas con el chat o solas) o en su propia fase. */
  private callsNow() {
    return PRIVATE_PHASES.includes(this.state.phase) && this.channels().voice;
  }

  /** En partida las voces se nombran por cuerpo; en el lobby y en resultados, por la persona. */
  private voiceByBody() {
    return !["LOBBY", "RESULTS"].includes(this.state.phase);
  }
  private voiceLabel(mind: string) {
    return this.voiceByBody() ? this.bodyOf.get(mind) ?? mind : mind;
  }
  private voiceMind(label: string) {
    return this.voiceByBody() ? this.mindInBody(label) ?? label : label;
  }

  /**
   * Qué voces oye `me` ahora (etiquetadas por cuerpo en partida) y la época de esas etiquetas.
   * Lobby y resultados: todos. ☀️ Chat global (voz): los cuerpos activos; los espectadores escuchan.
   * 🌙 Chat privado (voz): solo con quien estés en llamada, si los dos se eligieron. Resto de fases: nadie.
   */
  private audibleFor(me: string): { bodies: string[]; epoch: string } {
    const ph = this.state.phase;
    const epoch = this.voiceByBody() ? `b${this.bodyEpoch}` : "id";
    const ready = [...this.sfuPeers.entries()].filter(([id, p]) => id !== me && p.ready && p.pub).map(([id]) => id);
    let minds: string[] = [];
    if (ph === "LOBBY" || ph === "RESULTS") minds = ready;
    else if (this.callsNow()) {
      const t = this.callTarget.get(me);
      if (this.isActive(me)) minds = ready.filter((m) => m === t && this.callTarget.get(m) === me && this.isActive(m));
    } else if (!PRIVATE_PHASES.includes(ph) && this.channels().voice) minds = ready.filter((m) => this.isActive(m));
    return { bodies: minds.map((m) => this.voiceLabel(m)), epoch };
  }

  /** Manda a cada uno qué voces tiene que oír (solo si cambió), y el estado de las llamadas de la noche. */
  private pushAudible() {
    this.trackCalls();
    for (const [pid, peer] of this.sfuPeers) {
      const c = this.clientOf(pid);
      if (!c || !peer.sub) continue;
      const a = this.audibleFor(pid);
      const key = JSON.stringify(a);
      if (peer.sent === key) continue;
      peer.sent = key;
      c.send("sfuPubs", a);
    }
    this.pushCalls();
  }

  /**
   * 📻 Llamadas conectadas (los dos se eligieron): cuentan para el grafo y los detalles, con su duración.
   * Se llama en cada cambio de llamadas y de fase (al salir de la noche se cierran todas).
   */
  private trackCalls() {
    const now = Date.now();
    const live = new Set<string>();
    for (const [a, b] of this.callTarget) if (a < b && this.callTarget.get(b) === a) live.add(`${a}|${b}`);
    for (const k of live) {
      if (this.callSince.has(k)) continue;
      this.callSince.set(k, now);
      this.callPairs.add(k);
      const [a, b] = k.split("|");
      this.logNight(a, b, (e) => e.calls++);
    }
    for (const [k, since] of this.callSince) {
      if (live.has(k)) continue;
      this.callSince.delete(k);
      const [a, b] = k.split("|");
      this.logNight(a, b, (e) => (e.callSec += Math.round((now - since) / 1000)));
    }
  }

  /** 📻 Llamadas: a quién llamas, quién te llama y con quién ya hablaste (cuerpos). */
  private pushCalls() {
    for (const [pid, c] of this.clientOfPid) {
      let st = { target: "", incoming: [] as string[], pairs: [] as string[] };
      if (this.callsNow() && this.isActive(pid)) {
        const t = this.callTarget.get(pid);
        st = {
          target: t ? this.bodyOf.get(t) ?? "" : "",
          incoming: [...this.callTarget].filter(([m, to]) => to === pid && t !== m).map(([m]) => this.bodyOf.get(m) ?? ""),
          pairs: [...this.callPairs].map((k) => k.split("|")).filter((ab) => ab.includes(pid)).map(([a, b]) => this.bodyOf.get(a === pid ? b : a) ?? ""),
        };
      }
      const key = JSON.stringify(st);
      if (this.lastCalls.get(pid) === key) continue;
      this.lastCalls.set(pid, key);
      c.send("callState", st);
    }
  }

  private sfuClosePub(peer: SfuPeer) {
    if (peer.pub && peer.pubMid) {
      sfu.close(peer.pub, [peer.pubMid]).catch((e) => console.warn("[voz] no se pudo cerrar una publicación:", e.message));
    }
    Object.assign(peer, { pub: undefined, pubMid: undefined, ready: false });
  }

  /** Olvida las sesiones SFU de un jugador y deja de publicar su voz. */
  private sfuDrop(pid: string) {
    const peer = this.sfuPeers.get(pid);
    if (!peer) return;
    const wasPublic = peer.ready;
    this.sfuClosePub(peer);
    this.sfuPeers.delete(pid);
    if (wasPublic) this.pushAudible();
  }

  // ---------------- helpers ----------------

  /** Variantes de voz: entre quienes tienen el mismo tipo, 0, 1, 2… por orden de llegada. */
  private assignVoiceVariants() {
    const byType = new Map<string, Player[]>();
    for (const p of this.state.players.values()) {
      if (["", "listen"].includes(p.voice)) {
        p.voiceVariant = 0;
        continue;
      }
      byType.set(p.voice, [...(byType.get(p.voice) ?? []), p]);
    }
    for (const list of byType.values()) {
      list.sort((a, b) => (this.joinSeq.get(a.id) ?? 0) - (this.joinSeq.get(b.id) ?? 0));
      list.forEach((p, i) => (p.voiceVariant = i));
    }
  }

  /** Todo lo privado que un cliente necesita (también sirve para reconectar). */
  private sendIdentity(client: Client) {
    const id = this.pid(client);
    const ph = this.state.phase;
    const role = isImmutableMode(this.state.settings.mode) && ph !== "LOBBY"
      ? (id === this.immutableId ? "immutable" : "changer")
      : null;
    const spectator = ph !== "LOBBY" && !!this.state.players.get(id) && !this.isActive(id);
    client.send("identity", { mindId: id, bodyId: this.bodyOf.get(id) ?? id, role, spectator });
    client.send("chatHistory", this.chatLog);
    if (ph === "EXACT") client.send("myRatings", this.ratings.get(id) ?? {});
    if (ph === "NIGHT") {
      client.send("quota", { used: this.initiated.get(id) ?? 0 });
      const mine = this.dmLog
        .filter((d) => d.a === id || d.b === id)
        .map((d) => ({ fromBody: d.fromBody, text: d.text, ts: d.ts, withBody: this.bodyOf.get(d.a === id ? d.b : d.a)! }));
      client.send("dmHistory", mine);
    }
    if (PRIVATE_PHASES.includes(ph) && spectator) client.send("chatGraph", this.chatGraph());
    if (ph === "VERDICT" && this.verdict) client.send("verdict", this.verdict);
    if (PRIVATE_PHASES.includes(ph)) this.pushCalls();
    if (ph === "RESULTS" && this.lastResults) client.send("results", this.lastResults);
  }

  private mindInBody(bodyId: string) {
    for (const [m, b] of this.bodyOf) if (b === bodyId) return m;
    return undefined;
  }

  private pid(client: Client) {
    return this.pidOf.get(client.sessionId) ?? client.sessionId;
  }

  private bind(client: Client, pid: string) {
    this.lastCalls.delete(pid); // la conexión nueva necesita el estado de llamadas completo
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

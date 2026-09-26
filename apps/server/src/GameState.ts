import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

/**
 * Estado PÚBLICO (se sincroniza con todos los clientes).
 * OJO: aquí NO va el mapeo mente -> cuerpo ni quién es el Inmutable. Eso vive privado en GameRoom.
 * `id`/`name` identifican a la persona (y a su cuerpo original, que lleva su nombre).
 */
export class Player extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("string") color = "#ff4d8d";
  @type("string") avatar = ""; // "estilo:semilla" (DiceBear)
  @type("number") score = 0; // acumulado entre rondas
  @type("number") lastPoints = 0; // puntos de la última ronda
  @type("boolean") connected = true;
  @type("boolean") submitted = false; // ya respondió / votó / envió sus adivinanzas
  @type("boolean") skipVote = false; // votó por saltar la fase actual
  @type("boolean") out = false; // su MENTE fue expulsada: es espectador
  @type("boolean") bodyOut = false; // su CUERPO salió del juego
}

export type Mode = "classic" | "all" | "immutable" | "still";

/** Configuración de la partida (la edita el host en el lobby). Un tiempo en 0 apaga esa fase. */
export class Settings extends Schema {
  @type("string") mode: Mode = "classic";
  @type("number") cycles = 0; // 0 = automático según modo y jugadores
  @type("number") questionSeconds = 45;
  @type("number") threadSeconds = 30; // por cada respuesta
  @type("number") daySeconds = 120;
  @type("number") nightSeconds = 90;
  @type("number") guessSeconds = 90; // votación final: ¿Quién es quién? / Juicio Final
  @type("number") chatsPerNight = 0; // 0 = automático según nº de jugadores
  @type("boolean") earlyVote = false; // Desenmascare / Votación entre ciclos
  @type("number") voteSeconds = 30;
  @type("number") maxEjections = 1; // 0 = sin límite
  @type("boolean") unmaskSame = false; // (Clásico) se puede desenmascarar a quien no cambió
}

/** Respuesta en El Hilo (un "cotorreo" en Cotorra 🦜). */
export class Reply extends Schema {
  @type("string") id = "";
  @type("string") body = "";
  @type("string") text = "";
  @type("number") likes = 0;
  @type("number") sus = 0; // 🤨 "esto no lo escribiría su dueño"
}

export class Post extends Schema {
  @type("string") id = "";
  @type("string") body = "";
  @type("string") text = "";
  @type("number") likes = 0;
  @type("number") sus = 0;
  @type([Reply]) replies = new ArraySchema<Reply>();
}

export type Phase =
  | "LOBBY" | "SWAP" | "QUESTION" | "THREAD" | "DAY" | "NIGHT"
  | "UNMASK" | "VOTE" | "VERDICT" | "GUESS" | "FINAL_VOTE" | "RESULTS";

export class GameState extends Schema {
  @type("string") phase: Phase = "LOBBY";
  @type("number") cycle = 0;
  @type("number") totalCycles = 0; // ciclos efectivos de esta ronda (Auto ya resuelto)
  @type("number") round = 0;
  @type("number") timer = 0;
  @type("string") hostId = "";
  @type("number") minPlayers = 5;
  @type("number") maxPlayers = 12;
  @type("number") chatLimit = 2; // chats que cada quien puede INICIAR esta noche
  @type("string") question = "";
  @type([Post]) posts = new ArraySchema<Post>(); // respuestas del ciclo actual
  @type("number") thread = 0; // índice del post que se está comentando
  @type(Settings) settings = new Settings();
  @type({ map: Player }) players = new MapSchema<Player>();
}

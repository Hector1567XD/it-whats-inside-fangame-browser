import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

/**
 * Estado PÚBLICO (se sincroniza con todos los clientes).
 * OJO: aquí NO va el mapeo mente -> cuerpo. Eso vive privado en GameRoom.
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
  @type("boolean") submitted = false; // ya respondió la pregunta / envió sus adivinanzas
  @type("boolean") skipVote = false; // votó por saltar la fase actual
}

export type Mode = "classic" | "all";

/** Configuración de la partida (la edita el host en el lobby). Un tiempo en 0 apaga esa fase. */
export class Settings extends Schema {
  @type("string") mode: Mode = "classic";
  @type("number") cycles = 1; // repeticiones de Pregunta → Hilo → Chat global → Chat privado
  @type("number") questionSeconds = 45;
  @type("number") threadSeconds = 30; // por cada respuesta
  @type("number") daySeconds = 120;
  @type("number") nightSeconds = 90;
  @type("number") guessSeconds = 90;
  @type("number") chatsPerNight = 0; // 0 = automático según nº de jugadores
}

/** Respuesta en El Hilo, estilo post de X. */
export class Reply extends Schema {
  @type("string") id = "";
  @type("string") body = "";
  @type("string") text = "";
  @type("number") likes = 0;
}

export class Post extends Schema {
  @type("string") id = "";
  @type("string") body = "";
  @type("string") text = "";
  @type("number") likes = 0;
  @type([Reply]) replies = new ArraySchema<Reply>();
}

export type Phase = "LOBBY" | "SWAP" | "QUESTION" | "THREAD" | "DAY" | "NIGHT" | "GUESS" | "RESULTS";

export class GameState extends Schema {
  @type("string") phase: Phase = "LOBBY";
  @type("number") cycle = 0;
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

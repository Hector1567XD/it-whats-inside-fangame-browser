import { Schema, MapSchema, type } from "@colyseus/schema";

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
  @type("number") score = 0;
  @type("boolean") connected = true;
  @type("boolean") submitted = false; // ya envió sus adivinanzas
  @type("boolean") skipVote = false; // votó por saltar la fase actual
}

/** Configuración de la partida (la edita el host en el lobby). */
export class Settings extends Schema {
  @type("number") days = 3;
  @type("number") nights = 3; // noches tras los primeros N días (0..days)
  @type("number") daySeconds = 120;
  @type("number") nightSeconds = 90;
  @type("number") guessSeconds = 90;
  @type("number") chatsPerNight = 0; // 0 = automático según nº de jugadores
}

export type Phase = "LOBBY" | "SWAP" | "DAY" | "NIGHT" | "GUESS" | "RESULTS";

export class GameState extends Schema {
  @type("string") phase: Phase = "LOBBY";
  @type("number") dayCount = 0;
  @type("number") round = 0;
  @type("number") timer = 0;
  @type("string") hostId = "";
  @type("number") minPlayers = 4;
  @type("number") chatLimit = 2; // chats que cada quien puede INICIAR esta noche
  @type(Settings) settings = new Settings();
  @type({ map: Player }) players = new MapSchema<Player>();
}

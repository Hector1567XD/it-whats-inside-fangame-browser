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
  @type("number") score = 0;
  @type("boolean") connected = true;
  @type("boolean") submitted = false; // ya envió sus adivinanzas
}

export type Phase = "LOBBY" | "DAY" | "NIGHT" | "GUESS" | "RESULTS";

export class GameState extends Schema {
  @type("string") phase: Phase = "LOBBY";
  @type("number") dayCount = 0;
  @type("number") round = 0;
  @type("number") timer = 0;
  @type("string") hostId = "";
  @type("number") minPlayers = 4;
  @type({ map: Player }) players = new MapSchema<Player>();
}

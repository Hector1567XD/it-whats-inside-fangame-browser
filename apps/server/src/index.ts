import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameRoom } from "./GameRoom.js";

const PORT = Number(process.env.PORT ?? 2567);
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// ¿Existe la sala? (para validar links antes de pedir nombre)
app.get("/api/rooms/:code", async (req, res) => {
  const rooms = await matchMaker.query({ roomId: req.params.code.toUpperCase() });
  const r = rooms[0];
  res.json(r ? { exists: true, phase: r.metadata?.phase ?? "LOBBY", names: r.metadata?.names ?? [] } : { exists: false });
});

// En producción el server sirve el build del front (un solo deploy).
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|health).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

const server = http.createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server }) });
gameServer.define("game", GameRoom);

gameServer.listen(PORT).then(() => console.log(`🎮 Servidor en http://localhost:${PORT}`));

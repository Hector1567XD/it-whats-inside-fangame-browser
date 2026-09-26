import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameRoom, rtcStats } from "./GameRoom.js";

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

// Errores que antes se perdían: que queden en el log (Render › Logs).
process.on("uncaughtException", (e) => console.error("💥 uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("💥 unhandledRejection:", e));

// 📊 Uso de recursos cada minuto (STATS_SECONDS=0 lo apaga).
const STATS_SECONDS = Number(process.env.STATS_SECONDS ?? 60);
if (STATS_SECONDS > 0) {
  const mb = (b: number) => `${Math.round(b / 1048576)} MB`;
  let lastCpu = process.cpuUsage();
  let lastAt = Date.now();
  setInterval(async () => {
    const cpu = process.cpuUsage(lastCpu);
    const elapsed = (Date.now() - lastAt) * 1000; // µs
    lastCpu = process.cpuUsage();
    lastAt = Date.now();
    const m = process.memoryUsage();
    const rooms = await matchMaker.query({}).catch(() => []);
    const clients = rooms.reduce((n, r) => n + (r.clients ?? 0), 0);
    console.log(
      `📊 CPU ${((100 * (cpu.user + cpu.system)) / elapsed).toFixed(1)}% · RAM ${mb(m.rss)} (heap ${mb(m.heapUsed)}/${mb(m.heapTotal)})` +
      ` · sistema ${mb(os.totalmem() - os.freemem())}/${mb(os.totalmem())} · load ${os.loadavg()[0].toFixed(2)}` +
      ` · salas ${rooms.length} · clientes ${clients} · señales voz ${rtcStats.relayed} ok / ${rtcStats.dropped} descartadas`,
    );
    rtcStats.relayed = rtcStats.dropped = 0;
  }, STATS_SECONDS * 1000).unref();
}

import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS=1 npm run dev: https con certificado autofirmado, para probar el micrófono desde el celular
// (getUserMedia exige https o localhost). El front habla con el server por este mismo origen (proxy).
const https = process.env.HTTPS === "1";
const server = "http://localhost:2567";
const proxy: Record<string, ProxyOptions> = {
  "/matchmake": { target: server },
  "/api": { target: server },
  // WS de Colyseus: /{processId}/{roomId}
  "^/[\\w-]+/[A-Z0-9]{4}(\\?|$)": { target: server, ws: true },
};

// Los avatares de DiceBear pesan; 1.2 MB sin comprimir (~310 KB gzip) es aceptable para este juego.
export default defineConfig({
  plugins: [react(), ...(https ? [basicSsl()] : [])],
  server: { port: 5173, ...(https ? { proxy } : {}) },
  build: { chunkSizeWarningLimit: 1200 },
});

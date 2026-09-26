import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Los avatares de DiceBear pesan; 1.2 MB sin comprimir (~310 KB gzip) es aceptable para este juego.
export default defineConfig({ plugins: [react()], server: { port: 5173 }, build: { chunkSizeWarningLimit: 1200 } });

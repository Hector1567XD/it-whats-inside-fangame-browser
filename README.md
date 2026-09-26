# MindSwap 🧠🔀

Party game de deducción social por texto: al empezar, las mentes cambian de cuerpo **una sola vez** y hay que descubrir quién es quién.

Monorepo (npm workspaces):

- `apps/server` — Node + Express + Colyseus 0.16 (`GameRoom.ts`, `GameState.ts`)
- `apps/web` — Vite + React (un solo `App.tsx`)

## Correr en local

```bash
npm install
npm run dev          # server :2567 + web :5173
```

Abre http://localhost:5173 en varias pestañas (o ventanas de incógnito) para probar.

Para probar rápido con tiempos cortos y menos gente:

```bash
MIN_PLAYERS_CLASSIC=2 MIN_PLAYERS_IMMUTABLE=2 SWAP_SECONDS=5 npm run dev -w server   # en otra terminal: npm run dev -w web
```

## Producción (un solo servicio)

```bash
npm run build && npm start   # sirve API + WS + front en $PORT (default 2567)
```

Variables: `PORT`, `SWAP_SECONDS` (10), `VERDICT_SECONDS` (8). Mínimos por modo en el código (Clásico 5, Todos 4, El Inmutable 5, El No Cambiante 4); para pruebas se pisan con `MIN_PLAYERS_CLASSIC`, `MIN_PLAYERS_ALL`, `MIN_PLAYERS_IMMUTABLE`, `MIN_PLAYERS_STILL`. El viejo `MIN_PLAYERS` se ignora (deja un aviso en el log). Los tiempos de las fases se configuran en el lobby.

Deploy en Render: `render.yaml` en la raíz (blueprint, sin `rootDir`).
En el front, `VITE_SERVER_URL` si el server vive en otro dominio.

## Cómo funciona

1. Eliges username, avatar (Sonrisa / Aventura / Garabato; 🎲 cambia avatar y color) y el **modo** → **Crear sala**. Compartes el link `?room=CODE`. Hasta 12 jugadores.
2. **Modos:**
   - 🎲 **Clásico** (mín. 5): cambian entre 2 y N−2 al azar, una vez; nadie sabe cuántos. Final: 🧩 ¿Quién es quién?
   - 🔀 **Todos cambian** (mín. 4): todos cambian, una vez. Final: 🧩 ¿Quién es quién?
   - 🗿 **El Inmutable** (mín. 5): uno nunca cambia; los demás vuelven a cambiar cada ciclo. Final: ⚖️ Juicio Final.
   - 🪨 **El No Cambiante** (mín. 4): uno nunca cambia; los demás cambian una sola vez. Final: ⚖️ Juicio Final.
3. Ciclo: ❓ **La Pregunta** → 🦜 **El Hilo** (en Cotorra, la red social ficticia del juego: ❤️, 🤨 Sus, @menciones) → ☀️ **Chat global** → 🌙 **Chat privado** → (votación entre ciclos, opcional) → (🧳 re-cambio en El Inmutable). Ciclos en **Auto** según modo y jugadores (`rules.ts › autoCycles`).
4. **Votaciones entre ciclos** (check del lobby; con < 7 jugadores pide confirmación; no ocurre en el último ciclo):
   - 🎭 **El Desenmascare** (Clásico/Todos): una acusación "cuerpo X tiene a la mente Y". Sale si el 60% de los activos (sin contar al acusado) acierta la misma; máx. 1 por votación; conteo oculto. Check extra en Clásico: permitir desenmascarar a quien no cambió.
   - 🗳️ **La Votación** (Inmutables): estilo Among Us, gana el cuerpo con más votos aunque sea 1; empate u ⏭ Omitir = nadie.
   - **Máx. expulsiones** configurable (0 = sin límite).
5. Al expulsar, el cuerpo y la mente que tenía adentro salen: la mente queda de **espectador** (solo lee el chat público).
6. **Inmutables:** ganan los cambiantes si expulsan al Inmutable; gana el Inmutable si sobrevive al Juicio Final o si quedan 2.
7. **Puntos:** tabla en `apps/server/src/rules.ts › POINTS` (+200 acierto de cambio, +50 "no cambió", +150 Sigilo/Despiste, ±200 desenmascare, Inmutables +150/+200/−50 y +500/+100/+100).
8. El host configura modo, ciclos, checks y el tiempo de cada fase (0 = **Off**). Cualquiera vota ⏭ saltar (mayoría); el host tiene ⏩ Forzar.

Preguntas en `apps/server/src/questions.ts`.

Seguridad del secreto: el mapeo mente→cuerpo vive **solo en memoria privada del room** (no en el schema). Cada cliente recibe únicamente su propia identidad vía `identity`.

**Reconexión:**
- Recargar la página reconecta sola (token de Colyseus, 120 s de gracia).
- Si eso falla (otro dispositivo, se borró la pestaña, conexión "zombie"), entra a la sala con **el mismo nombre**: te pregunta "¿eres tú?" y retomas ese lugar (cuerpo, puntos, chats). Si la otra conexión seguía viva, se la saca con un aviso. Con la partida en curso solo se puede entrar así, eligiendo quién eras. Es inseguro a propósito: cualquiera que sepa tu nombre puede tomar tu lugar.

## Voz en el lobby 🎙️

Solo en la sala de espera: al empezar la partida se corta y al volver al lobby se rearma sola.

- La voz se modula **en el navegador** de quien habla (`apps/web/src/voice/`); a los demás solo les llega la voz procesada. Motores en orden de fallback: Signalsmith Stretch → Tone.js → nativo → robot. Para probar uno: `?voiceEngine=signalsmith|tone|native|robot`.
- El audio va **P2P** (malla WebRTC, 1 conexión por jugador) y Colyseus solo hace de señalización (mensaje `rtc`). No pasa por el server.
- **ICE:** por defecto solo STUN público. En redes 4G, CGNAT o corporativas hace falta un **TURN** (p. ej. coturn propio): `VITE_ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:mi.turn:3478","username":"u","credential":"p"}]'`. Se lee al compilar el front, así que en Render va como variable de entorno del build y hay que redeployar.
- **Diagnóstico:** la consola del navegador muestra los pasos con el prefijo `[voz]` (candidatos ICE, estados y el motivo si falla). El server imprime cada minuto `📊 CPU · RAM · salas · clientes · señales voz` (`STATS_SECONDS`, 0 = apagado) y los errores no capturados.
- **Probar en el celular:** `getUserMedia` exige https o localhost, así que por la IP de la red local el micrófono no anda. Usa `HTTPS=1 npm run dev` (certificado autofirmado, Vite hace de proxy al server) y entra a `https://<tu-ip>:5173`, o usa un túnel.

## Créditos de avatares

[DiceBear](https://www.dicebear.com) (MIT). Estilos: Big Smile (Ashley Seo), Adventurer (Lisa Wischofsky), Croodles (vijay verma) — CC BY 4.0.

## Pendiente

Espectadores, i18n, historial de DMs de noches anteriores.

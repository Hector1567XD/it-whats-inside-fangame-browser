# Plan: chat de voz modulada en el lobby (MVP)

> **Para:** la IA que va a implementar esto.
> **Alcance:** solo la **sala de espera (LOBBY)**. Todas las mecánicas del juego quedan **exactamente igual**. Al empezar la partida la voz se apaga; al volver al lobby, se enciende otra vez.
> **Decisiones del usuario:**
> - La modulación de voz se hace **en el navegador** (client side).
> - La retransmisión es **self-hosted**, sin servicios de pago.
> - Todo arranca con `npm run dev`, sin procesos extra.
> - No commitees sin que el usuario lo pida.

## 1. Qué construir (visión del jugador)

1. Al entrar a una sala (lobby) aparece un **modal de voz**:
   1. **"Activar micrófono"**. Es un botón porque hace falta un gesto del usuario para `getUserMedia` y para `AudioContext.resume()`, sobre todo en Safari/iOS.
   2. **"Elige tu voz":** tres tarjetas, **Femenina · Masculina · Neutra**.
   3. **"Calibrar":** "di *hola, soy yo y esta es mi voz*" durante 3 s. Se mide el tono base (F0) del jugador.
   4. **"Escúchate":** reproduce esa grabación ya modulada con tu voz asignada.
   5. **"¡Listo!"**. También hay dos salidas: **"Entrar sin micrófono (solo escuchar)"** y "Saltar".
   - Lo elegido se guarda en `localStorage`: tipo de voz y F0. La próxima vez el modal solo pide el permiso del micrófono, y se puede reabrir con un botón ⚙️ de la barra de voz.
2. Desde ese momento, en el lobby hay **chat de voz abierto entre todos**. Nadie oye tu voz real: los demás oyen tu **voz modulada**. El motivo es que esa voz es "la estática de tu cuerpo": más adelante, quien entre en tu cuerpo hablará con ella. Por eso tú también suenas modulado en tu propio cuerpo.
3. Si hay **varias personas con el mismo tipo** de voz, cada una suena **un poco distinta** (variantes). Por ejemplo, dos chicas: "Femenina 1" y "Femenina 2".
4. El **host** tiene un ajuste nuevo en la configuración: **📻 Walkie-talkie: 0 (off) · 1 (poquita distorsión) · 2 (bastante)**. Se aplica a todos.
5. **Barra de voz** en el lobby:
   - 🎙️ mute y unmute del micrófono (abierto por defecto tras el setup).
   - 🔈 silenciar todo lo que llega ("ensordecer").
   - ⚙️ reconfigurar la voz.
   - Indicador del motor en uso (ver §3).
6. **Lista de jugadores** del lobby: icono del tipo de voz (♀ / ♂ / ⚪, o 🙊 si no tiene micrófono), 🔇 si está muteado, y un **anillo que brilla cuando habla** (se detecta en el cliente con un `AnalyserNode`).
7. Al pasar de LOBBY a cualquier otra fase se cierran todas las conexiones de voz y el micrófono se libera. Al volver al LOBBY (tras RESULTS) se reconecta solo, sin repetir el setup.

## 2. Arquitectura

```
[mic] → getUserMedia (echoCancellation, noiseSuppression, autoGainControl)
      → VoiceChain (en el navegador de quien habla):
            motor de tono (Signalsmith → Tone → nativo → robot)
          → timbre (lowshelf + highshelf)
          → walkie (0/1/2)
          → compresor
          → MediaStreamAudioDestinationNode
      → pista procesada → RTCPeerConnection (malla P2P, 1 conexión por cada otro jugador)
      → los demás la reproducen con un <audio> por peer

Señalización WebRTC (ofertas, respuestas, ICE): por el WebSocket de Colyseus que ya existe (mensaje "rtc").
```

- **Transporte: malla P2P WebRTC con Colyseus como señalización.** Es la opción self-hosted más simple:
  - No agrega ningún servidor ni proceso.
  - Funciona con `npm run dev` y en Render, porque el audio no pasa por Render: va de navegador a navegador. Solo la señalización pasa por el WS.
  - Con máximo 12 jugadores, cada uno envía 11 flujos Opus de voz, unos 350 kbps de subida. Es aceptable para un lobby.
  - **Más adelante**, cuando la voz vaya dentro de la partida, habrá que pasar a un SFU self-hosted (LiveKit OSS o mediasoup en un VPS con UDP). No lo hagas ahora; ver §9.
- **La voz real nunca sale del dispositivo:** al peer se le agrega **solo** la pista procesada, nunca la del micrófono.
- **ICE:** STUN público por defecto (`stun:stun.l.google.com:19302`), configurable con `VITE_ICE_SERVERS` (JSON con la forma de `RTCIceServer[]`) para poner TURN propio (coturn) después. Sin TURN, algunas redes (4G, corporativas) no conectan; está aceptado para el MVP. Muéstralo como "no se pudo conectar con X".

## 3. Motores de voz y fallback (prioridad del usuario)

Orden fijo:

1. **Signalsmith Stretch** (npm `signalsmith-stretch@1.3.2`, MIT, WASM + AudioWorklet). Es el preferido porque mueve tono y formantes por separado.
2. **Tone.js `PitchShift`** (npm `tone@15.1.22`). Delay-lines, sin worklet.
3. **Nativo (delays)**: pitch shifter propio con `DelayNode`, sin librerías.
4. **Robot (vocoder)**: último recurso.

Cómo elegir el motor:
- Se prueba en orden.
- Un motor "falla" si lanza un error, si no queda listo en **5 s** (Signalsmith espera un mensaje `ready` del worklet que puede no llegar nunca), o si no hay `AudioWorklet`.
- Se usa el primero que funcione, y el motor elegido se muestra en la barra de voz.
- Para probar, permite forzar uno con `?voiceEngine=signalsmith|tone|native|robot`.

**Código de referencia ya probado:** `mockups/voz-v5.html` tiene funcionando las cuatro implementaciones, la detección de F0 (autocorrelación: `detectF0` y `medianF0`), el timbre (`buildPost`) y el walkie. Pórtalo a TypeScript. Importa `signalsmith-stretch` y `tone` **desde npm, con `import()` dinámico** (no desde un CDN), para que todo sea self-hosted y se cargue solo cuando haga falta.
- Signalsmith: `const node = await SignalsmithStretch(ctx); node.schedule({ active: true, semitones, formantSemitones, formantCompensation: true, formantBaseHz: f0 }); src.connect(node); node.connect(dst)`.
- Tone: `Tone.setContext(ctx)` (sirve con el `AudioContext` nativo), `new Tone.PitchShift({ pitch, windowSize: 0.08 })`, `Tone.connect(nativeGain, ps)` y `ps.connect(dst)`.
- Signalsmith crea su worklet desde una URL `blob:`. Funciona por http(s) y en localhost; **no** funciona en `file://` (el juego nunca se sirve así).

## 4. Voces: tipo + variante → parámetros

El **server** asigna la variante y el **cliente** calcula los parámetros. Todos los clientes llegan al mismo resultado porque se calcula con datos del estado.

`presets.ts` (ajustable de oído):

| Tipo | Tono destino (Hz) por variante 0,1,2,3… | Formantes (semitonos) | Timbre (dB) |
|---|---|---|---|
| masc | 115, 100, 132, 108, 124… | −2 + (−0,5, +0,5, −1, +1…) | −3 ± 1 |
| fem | 215, 195, 238, 205, 228… | +2,5 + (±0,5, ±1…) | +3 ± 1 |
| neutral | 160, 145, 176, 152, 168… | 0 + (±0,5…) | 0 ± 1 |

- `semitones = clamp(12 · log2(tonoDestino / f0Jugador), −12, +12)`, redondeado a 0,5.
- Si el jugador no calibró, usa f0 = 150 Hz.
- Motores 2 y 3 (Tone y nativo): no controlan formantes. Usa solo `semitones` y el timbre.
- Robot: la frecuencia de la portadora sale del tono destino (masc ≈ 100 Hz, fem ≈ 200 Hz, neutral ≈ 150 Hz, más o menos la variante), así que también se distinguen.
- **Walkie** (se aplica al final de la cadena de quien habla):
  - 0 = nada.
  - 1 = highpass 300 Hz + lowpass 3.400 Hz + saturación suave (`tanh(1.5x)`).
  - 2 = highpass 500 Hz + lowpass 2.600 Hz + saturación fuerte (`tanh(4x)`) + un poco de ruido de fondo a −35 dB.
  - Al cambiarlo, se reconstruye la cadena sin cortar la pista: reconecta los nodos antes del `MediaStreamDestination`, que sigue siendo el mismo, así no hay que renegociar el WebRTC.

## 5. Cambios en el server (`apps/server`)

`GameState.ts`:
- En `Player`, agregar:
  - `@type("string") voice = ""` (`"" | "fem" | "masc" | "neutral"`; vacío = sin voz o solo escucha).
  - `@type("number") voiceVariant = 0`.
  - `@type("boolean") micOn = false`.
- En `Settings`, agregar `@type("number") voiceWalkie = 0` (0–2).
- **No** guardes el F0 en el estado: se queda en el cliente, porque cada uno modula su propia voz.

`GameRoom.ts`:
- `onMessage("voiceProfile", { voice, micOn })`:
  - Valida los valores y guárdalos en el `Player`.
  - Recalcula las variantes: para cada tipo, ordena a los jugadores con ese tipo por orden de llegada (guarda un `joinSeq` privado en el room) y asigna 0, 1, 2… Vuelve a calcular también en `onJoin` y en `onLeave` del lobby.
  - Se permite en cualquier fase: solo es un perfil y no toca mecánicas.
- `onMessage("rtc", { to, data })`:
  - **Solo en fase LOBBY.** `to` tiene que ser el id de un jugador conectado distinto del emisor.
  - `data` es un objeto con `description` (SDP) o `candidate`.
  - Descarta mensajes de más de 20 KB (`JSON.stringify(data).length`).
  - Reenvía a ese cliente `{ from: pidEmisor, data }` con `this.clientOf(to)?.send("rtc", …)`.
  - Aplica un rate limit simple por jugador, por ejemplo 50 mensajes/s.
- `settings`: acepta `voiceWalkie` con `clamp(…, 0, 2, …)`. Solo el host y en LOBBY, igual que el resto de los ajustes.
- Reconexión o *takeover*: el `Player` conserva `voice` y `voiceVariant`. Al reconectar, el cliente rehace la malla.
- Si hace falta, sube `maxPayload` del `WebSocketTransport` en `index.ts` (no debería, los SDP son pequeños).
- **No toques nada más** de `GameRoom` (fases, puntos, votos, identidad).

## 6. Cambios en el cliente (`apps/web`)

Dependencias: `npm i -w web signalsmith-stretch@1.3.2 tone@15.1.22`.

Módulos nuevos en `apps/web/src/voice/`:
- **`pitch.ts`**: `detectF0` y `medianF0`, portados de `voz-v5.html`.
- **`presets.ts`**: tabla de §4 y `paramsFor(voice, variant, f0)` → `{ semitones, formant, tilt, robotHz }`.
- **`engines.ts`**: los 4 motores, todos con la misma interfaz, por ejemplo `build(ctx, input, output, params) → { stop() }`, más `pickEngine()` con el fallback y el timeout de §3.
- **`chain.ts`**: clase `VoiceChain`.
  - Contiene `ctx`, el micrófono, el motor, el timbre, el walkie, el compresor y un `MediaStreamDestination`.
  - Métodos:
    - `start()`
    - `setParams()`
    - `setWalkie(level)`
    - `setMuted(bool)`: pone `track.enabled` y no para el micrófono.
    - `outputTrack`
    - `previewBuffer(buffer)`: para "escúchate" en el setup; reproduce por los altavoces locales, nunca por el peer.
    - `destroy()`
  - Expone también un analizador local para el anillo de "hablando".
- **`mesh.ts`**: clase `VoiceMesh(room, myId, track)`.
  - Usa el patrón **perfect negotiation** de MDN: *polite* = el id menor. Maneja `onnegotiationneeded`, ICE y rollback.
  - Tiene un `RTCPeerConnection` por jugador presente. Cuando entra alguien nuevo, se conecta a él; cuando se va, se cierra.
  - Escucha `room.onMessage("rtc")` y envía con `room.send("rtc", { to, data })`.
  - El audio remoto va a un `<audio autoplay playsinline>` por peer, fuera del DOM visible.
  - Para medir el nivel de cada peer: `ctx.createMediaStreamSource(remoteStream)` → `AnalyserNode`. En Chrome, el stream remoto debe estar también en el `<audio>`: sin eso, Web Audio no recibe muestras.
  - Expone `levels: Record<playerId, number>`, `state: Record<playerId, RTCPeerConnectionState>` y `deafen(bool)`.
- **`useVoice.ts`**: hook que arma todo.
  - Decide cuándo mostrar el modal.
  - Crea la `VoiceChain` y la `VoiceMesh` **solo cuando `phase === "LOBBY"`** y las destruye al salir del lobby.
  - Envía `voiceProfile`.
  - Reacciona a los cambios de `voiceVariant` y de `settings.voiceWalkie` sin reconectar.
- **`VoiceSetup.tsx`**: el modal de §1 (permiso, tipo, calibración de 3 s grabando con `MediaRecorder` + `decodeAudioData`, "escúchate", listo). Reusa las clases del juego (`modal`, `card`, `btn`, `mode`).
- **`VoiceBar.tsx`**: la barra de §1.5.

Integración (cambios mínimos):
- `App.tsx › Game`: llama a `useVoice(room, s, me)`.
- `Lobby`: muestra `VoiceBar` y el modal.
- En la lista `.plist` del lobby: icono de voz, 🔇 y la clase `speaking` (anillo) según `levels`.
- `SettingsPanel`: una fila "📻 Walkie-talkie" con stepper 0/1/2 (etiquetas: Off / Poquito / Bastante), igual que las demás filas y editable solo por el host.
- `net.ts`: agrega `voice`, `voiceVariant` y `micOn` a `PlayerView`, y `voiceWalkie` a `Settings`.
- CSS en `style.css`: sigue el estilo del juego (Lilita One para títulos, fondos degradados, tarjetas con borde blanco translúcido).

## 7. Detalles que suelen romperse

- **Micrófono en el celular durante el dev:** `getUserMedia` exige https o localhost. Si se entra por la IP de la red local (`vite --host`), el micrófono no funciona en el celular. Para probar en móvil, usa `@vitejs/plugin-basic-ssl` detrás de un flag (por ejemplo `HTTPS=1`) o un túnel. Documéntalo en el README.
- **Safari / iOS:**
  - `AudioContext` y `audio.play()` solo arrancan tras un toque: el botón del modal lo resuelve.
  - Si `play()` falla, muestra un botón "🔈 Activar audio".
  - Pide `getUserMedia` una sola vez y reusa el stream.
- **Eco:** deja `echoCancellation: true` en el micrófono y recomienda audífonos en el modal.
- **Autoplay:** los `<audio>` remotos se crean después de la interacción del modal.
- **No filtres la voz real:** revisa que `pc.addTrack` reciba siempre `chain.outputTrack` y nunca la pista del micrófono.
- **Espectadores y fases:** fuera del LOBBY no hay voz, así que no hay casos raros con espectadores ni cuerpos.
- **Limpieza:** al salir del lobby o de la sala, cierra todos los peers, para las pistas del micrófono (`track.stop()`) y cierra el `AudioContext`.

## 8. Cómo verificarlo

1. `npm run build -w server` y `npm run build -w web` (o `tsc` en ambos) sin errores.
2. **Manual (lo principal):** `npm run dev` y 2–3 pestañas o navegadores en `http://localhost:5173`, con audífonos.
   - Cada uno hace el setup con tipos distintos y con tipos repetidos, y se tienen que oír modulados y distintos entre sí.
   - Prueba el mute, el ensordecer y el walkie 0/1/2 desde el host.
   - Al darle Empezar la voz se corta. Al volver al lobby desde Resultados, se reconecta.
3. **Fallback:** prueba con `?voiceEngine=tone`, `native` y `robot` que cada motor funciona. Con `?voiceEngine=signalsmith` en un navegador sin worklet, debe pasar solo a Tone.
4. **Automatizado (opcional):** Playwright con Chrome y los flags `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`. Con 2 contextos, comprueba que `connectionState === "connected"` y que llega nivel de audio.
   - Ojo: en Chrome **headless** Signalsmith no arranca (su worklet nunca responde, ni en la demo oficial del autor). Por eso el fallback tiene que llevarlo a Tone solo, y eso también sirve de prueba.
5. **Nada más cambió:** una partida completa (pregunta → hilo → día → noche → votación → resultados) funciona igual que antes.
6. Nota conocida del dev, que no hay que arreglar aquí: `/api/rooms` no manda CORS. Unirse por código entre puertos distintos en dev da "Failed to fetch"; para las pruebas usa el link `?room=`.

## 9. Fuera de alcance (para después, no implementar)

- Voz dentro de la partida (nueva fase, notas de voz, chat grupal…). Lo decidirá el usuario.
  - **Aviso de seguridad para ese momento:** en una malla P2P cada conexión va atada al id del jugador (la mente). Dentro de la partida eso revelaría quién está en qué cuerpo. Harán falta un SFU (LiveKit OSS o mediasoup) con identidades de **cuerpo**, o un relay por el server.
- TURN propio (coturn) y despliegue en un VPS.
- Volumen por jugador, push-to-talk, moderación.

## 10. Archivos

- Nuevos:
  - `apps/web/src/voice/pitch.ts`
  - `apps/web/src/voice/presets.ts`
  - `apps/web/src/voice/engines.ts`
  - `apps/web/src/voice/chain.ts`
  - `apps/web/src/voice/mesh.ts`
  - `apps/web/src/voice/useVoice.ts`
  - `apps/web/src/voice/VoiceSetup.tsx`
  - `apps/web/src/voice/VoiceBar.tsx`
- Modificados:
  - `apps/server/src/GameState.ts`
  - `apps/server/src/GameRoom.ts` (solo `voiceProfile`, `rtc`, `voiceWalkie` en settings y el recálculo de variantes)
  - `apps/web/src/net.ts`
  - `apps/web/src/App.tsx` (hook, barra, lista y ajuste del host)
  - `apps/web/src/style.css`
  - `apps/web/package.json`
  - `README.md` (sección "Voz en el lobby" y cómo probar en el celular)
  - `game-context.md` (una línea en "Decisiones": voz modulada en el cliente, malla P2P solo en el lobby)
- Referencia: `mockups/voz-v5.html` (motores ya probados) y `mockups/voz-v4.html` (contexto de la decisión).

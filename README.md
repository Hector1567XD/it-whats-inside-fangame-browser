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
MIN_PLAYERS=2 SWAP_SECONDS=5 npm run dev -w server
```

## Producción (un solo servicio)

```bash
npm run build && npm start   # sirve API + WS + front en $PORT (default 2567)
```

Variables: `PORT`, `MIN_PLAYERS` (4), `SWAP_SECONDS` (10), y los valores por defecto de tiempos `DAY_SECONDS` (120), `NIGHT_SECONDS` (90), `GUESS_SECONDS` (90) — el host los puede cambiar en el lobby.

Deploy en Render: `render.yaml` en la raíz (blueprint, sin `rootDir`).
En el front, `VITE_SERVER_URL` si el server vive en otro dominio.

## Cómo funciona

1. Eliges username, avatar (6 estilos de DiceBear + 🎲) y color → **Crear sala** (código de 4 letras). Compartes el link `?room=CODE`.
2. En el lobby el host configura **días, noches, duración de cada fase y chats por noche**.
3. Host inicia (4–8 jugadores). **Cambio de cuerpos** (ruleta animada, una sola vez: nadie queda en su propio cuerpo y, si se puede, nadie repite el cuerpo de la ronda anterior) → Día 1 → Noche 1 → Día 2 → … → Adivinanza → Resultados. Hay noche después de los primeros *N* días (N = noches configuradas).
4. **Día:** chat grupal; cada mensaje sale con el nombre y avatar del *cuerpo*, nunca de la mente.
5. **Noche:** DMs 1 a 1. Cada quien puede **iniciar** un número limitado de chats (auto: 2 con ≤5 jugadores, 3 con 6–7, 4 con 8; o fijo 1–7). Responder a quien te escribe es gratis. El letrero de la noche y el contador `1/2 disponibles` lo avisan.
6. **Adivinanza:** para cada cuerpo eliges qué mente está dentro. +200 por acierto, +150 si menos del 50% de los rivales te descubrió.
7. **Saltar:** cualquiera puede votar ⏭ (se salta con mayoría de los conectados). El host además tiene **⏩ Forzar**.
8. Resultados con revelación una por una; el host lanza **Siguiente ronda** (el marcador se acumula).

Letreros animados por fase, sonidos sintetizados con WebAudio (botón 🔊/🔇) y confeti.

Seguridad del secreto: el mapeo mente→cuerpo vive **solo en memoria privada del room** (no en el schema). Cada cliente recibe únicamente su propia identidad vía `identity`.

**Reconexión:**
- Recargar la página reconecta sola (token de Colyseus, 120 s de gracia).
- Si eso falla (otro dispositivo, se borró la pestaña, conexión "zombie"), entra a la sala con **el mismo nombre**: te pregunta "¿eres tú?" y retomas ese lugar (cuerpo, puntos, chats). Si la otra conexión seguía viva, se la saca con un aviso. Con la partida en curso solo se puede entrar así, eligiendo quién eras. Es inseguro a propósito: cualquiera que sepa tu nombre puede tomar tu lugar.

## Créditos de avatares

[DiceBear](https://www.dicebear.com) (MIT). Estilos: Fun Emoji (Davis Uche), Big Smile (Ashley Seo), Adventurer (Lisa Wischofsky), Croodles (vijay verma) — CC BY 4.0; Bottts (Pablo Stanley) — libre uso; Thumbs (DiceBear) — CC0.

## Pendiente

Espectadores, i18n, historial de DMs de noches anteriores.

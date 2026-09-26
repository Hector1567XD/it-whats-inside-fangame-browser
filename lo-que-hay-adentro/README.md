# Lo Que Hay Adentro (fangame MVP)

Party game de texto inspirado en *It's What's Inside*: las mentes cambian de cuerpo cada noche y hay que descubrir quién es quién.

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
MIN_PLAYERS=2 DAY_SECONDS=20 NIGHT_SECONDS=15 npm run dev -w server
```

## Producción (un solo servicio)

```bash
npm run build && npm start   # sirve API + WS + front en $PORT (default 2567)
```

Variables: `PORT`, `MIN_PLAYERS` (4), `DAY_SECONDS` (120), `NIGHT_SECONDS` (90), `GUESS_SECONDS` (90).
En el front, `VITE_SERVER_URL` si el server vive en otro dominio.

## Cómo funciona

1. Pones username + color → **Crear sala** (código de 4 letras). Compartes el link `?room=CODE`.
2. Host inicia (4–8 jugadores). Día 1 → Noche 1 (swap) → Día 2 → Noche 2 (swap) → Día 3 → Noche 3 (swap) → Adivinanza → Resultados.
3. **Día:** chat grupal; cada mensaje sale con el nombre del *cuerpo*, nunca de la mente.
4. **Noche:** intercambio secreto (derangement: nadie se queda en el cuerpo que tenía y, si se puede, tampoco vuelve al suyo) y DMs 1 a 1 con máx. 2 cuerpos.
5. **Adivinanza:** para cada cuerpo eliges qué mente está dentro. +200 por acierto, +150 si menos del 50% de los rivales te descubrió.
6. El host puede **Saltar ⏭** fases (útil para probar) y lanzar **Siguiente ronda** (el marcador se acumula).

Seguridad del secreto: el mapeo mente→cuerpo vive **solo en memoria privada del room** (no en el schema). Cada cliente recibe únicamente su propia identidad vía `identity`.

Recargar la página reconecta a la sala (120 s de gracia).

## Pendiente (post-MVP)

Estética Gartic/Make it Meme, avatares ilustrados, sonidos, animaciones de swap, espectadores, i18n.

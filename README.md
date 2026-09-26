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
MIN_PLAYERS=2 SWAP_SECONDS=5 npm run dev -w server   # en otra terminal: npm run dev -w web
```

## Producción (un solo servicio)

```bash
npm run build && npm start   # sirve API + WS + front en $PORT (default 2567)
```

Variables: `PORT`, `SWAP_SECONDS` (10), `MIN_PLAYERS` (solo para pruebas: pisa el mínimo de cada modo). Los tiempos de las fases se configuran en el lobby.

Deploy en Render: `render.yaml` en la raíz (blueprint, sin `rootDir`).
En el front, `VITE_SERVER_URL` si el server vive en otro dominio.

## Cómo funciona

1. Eliges username, avatar (Sonrisa / Aventura / Garabato; 🎲 cambia avatar y color) y el **modo** → **Crear sala**. Compartes el link `?room=CODE`. Hasta 12 jugadores.
2. **Modos:**
   - 🎲 **Clásico** (mín. 5): cambian entre 2 y N−2 jugadores al azar; siempre quedan al menos 2 en su propio cuerpo y nadie sabe cuántos cambiaron.
   - 🔀 **Todos cambian** (mín. 4): todas las mentes cambian.
3. 🧳 **La máquina** hace el cambio UNA vez al empezar (nadie repite el cuerpo de la ronda anterior si se puede).
4. Ciclo (por defecto ×1): ❓ **La Pregunta** (todos responden la misma pregunta desde su cuerpo) → 🐦 **El Hilo** (cada respuesta sale como post de X y todos la comentan, 30 s por respuesta, con ❤️) → ☀️ **Chat global** (con las respuestas al lado) → 🌙 **Chat privado** (cada quien puede INICIAR pocos chats; auto: ⌊N/2⌋ entre 2 y 5).
5. 🔍 **Adivinanza:** para cada cuerpo, qué mente hay adentro (o "🙋 No cambió" en Clásico).
6. **Puntos:** +200 por descubrir un cambio, +50 por acertar que alguien no cambió, +150 🥷 *Sigilo* (cambiaste y menos de la mitad te descubrió) o +150 🎭 *Despiste* (NO cambiaste y la mitad o más creyó que sí).
7. **Resultados:** revelación cuerpo por cuerpo → "Tu ronda" (tus adivinanzas y de dónde salió cada punto) → puntos de esa ronda. El acumulado se ve en la sala de espera.
8. El host configura modo, ciclos y el tiempo de cada fase (0 = **Off**, esa fase se salta). Cualquiera vota ⏭ saltar (mayoría); el host tiene ⏩ Forzar.

Preguntas en `apps/server/src/questions.ts`.

Seguridad del secreto: el mapeo mente→cuerpo vive **solo en memoria privada del room** (no en el schema). Cada cliente recibe únicamente su propia identidad vía `identity`.

**Reconexión:**
- Recargar la página reconecta sola (token de Colyseus, 120 s de gracia).
- Si eso falla (otro dispositivo, se borró la pestaña, conexión "zombie"), entra a la sala con **el mismo nombre**: te pregunta "¿eres tú?" y retomas ese lugar (cuerpo, puntos, chats). Si la otra conexión seguía viva, se la saca con un aviso. Con la partida en curso solo se puede entrar así, eligiendo quién eras. Es inseguro a propósito: cualquiera que sepa tu nombre puede tomar tu lugar.

## Créditos de avatares

[DiceBear](https://www.dicebear.com) (MIT). Estilos: Big Smile (Ashley Seo), Adventurer (Lisa Wischofsky), Croodles (vijay verma) — CC BY 4.0.

## Pendiente

Espectadores, i18n, historial de DMs de noches anteriores.

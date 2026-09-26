# Contexto del juego — MindSwap 🧠🔀

> Documento vivo con el estado del juego y las decisiones tomadas. El plan visual (simulador de fases por modo, tablas y diagramas) está en el artifact "Plan de modos MindSwap".
> **✅ implementado** · **🚧 en progreso** · **⏳ sin decidir**

## Qué es

Party game de deducción social por texto, en navegador y en tiempo real, inspirado en la película *It's What's Inside* ("Lo que hay adentro"). Las mentes cambian de cuerpo y hay que descubrir quién está dentro de quién, mientras finges ser el dueño del cuerpo que ocupas. La película solo aparece como guiño ("lo que importa es lo que hay adentro", "la máquina", "la transferencia"); ni el nombre ni la marca se usan en el producto.

Stack: monorepo npm → `apps/server` (Node + Express + Colyseus 0.16) y `apps/web` (Vite + React). Todo vive en memoria, sin base de datos ni cuentas. Se despliega en Render como un solo servicio (`render.yaml` en la raíz).

## De dónde viene (spec original)

La primera versión seguía una spec de "3 días / 3 noches":
- De 4 a 8 jugadores. **Todos** cambiaban de cuerpo **cada noche** (derangement ×3).
- Día = chat grupal. Noche = DMs 1 a 1 (máx. 2).
- Al final, una matriz Cuerpo → Mente: +200 por acierto, +150 si menos del 50 % te descubría.

## Por qué cambió (feedback de las pruebas)

- **Si todos cambian, nadie tiene motivo para jugar bien.** La gente hablaba al pedo, no decía nada o fingía mal.
  - Idea: como *Undercover / Mr. White*, que **solo algunos cambien**, en una **cantidad desconocida**.
  - Se descartó "2 fijos" porque se reconocerían como pareja, y "50/50" porque da una probabilidad exacta.
- **Faltaba una excusa para hablar.** De ahí salieron **La Pregunta** y **El Hilo**.
- **La pantalla final no se entendía.** El acumulado pasó al lobby, y los resultados ahora explican *esta* partida.
- **Las rondas largas se volvían lentas y nadie arriesgaba.** De ahí salieron las **votaciones entre ciclos** con expulsión y los modos **Inmutables**, estilo Among Us / Hombre Lobo.
- **UX:**
  - Solo 3 estilos de avatar (Sonrisa, Aventura, Garabato), y el 🎲 también cambia el color.
  - El modo se elige en la pantalla del avatar.
  - Al abrir un chat, el foco va directo al input.
  - El badge rojo de un DM solo aparece con mensajes sin leer y solo los cuenta a ellos.

## Modos ✅

Hasta 12 jugadores en todos los modos.

| Modo | Mín. | Quién cambia | Votación entre ciclos (check) | Votación final (siempre) |
|---|---|---|---|---|
| 🎲 **Clásico** (principal) | 5 | Entre 2 y N−2 al azar, **una vez**. Siempre quedan ≥2 en su cuerpo y nadie sabe cuántos cambiaron. | 🎭 El Desenmascare | 🧩 ¿Quién es quién? |
| 🔀 **Todos cambian** | 4 | Todos, una vez. Todavía le buscamos sentido. | 🎭 El Desenmascare | 🧩 ¿Quién es quién? |
| 🗿 **El Inmutable** | 5 | Todos menos 1 (el Inmutable), y **vuelven a cambiar en cada ciclo**. | 🗳️ La Votación | ⚖️ Juicio Final |
| 🪨 **El No Cambiante** | 4 | Todos menos 1 (el No Cambiante), **una sola vez**. | 🗳️ La Votación | ⚖️ Juicio Final |

- Los dos Inmutables son variantes en prueba. En la versión final quizá quede uno solo.
- En los Inmutables cada quien conoce su rol: el Inmutable sabe que lo es, y cada cambiante sabe que cambió pero no quién es el Inmutable.
- **Mínimos por modo:** vienen en el código (`apps/server/src/rules.ts`) y cada uno se puede pisar para pruebas con `MIN_PLAYERS_CLASSIC`, `MIN_PLAYERS_ALL`, `MIN_PLAYERS_IMMUTABLE` y `MIN_PLAYERS_STILL`. `MIN_PLAYERS` a secas **se ignora** y deja un aviso en el log. Si en Render quedó `MIN_PLAYERS=4`, ya no afecta, pero conviene borrarla.

## Flujo de una ronda ✅

`🧳 La máquina → [❓ La Pregunta → 🦜 El Hilo → ☀️ Chat global → 🌙 Chat privado → (votación entre ciclos) → (re-cambio)] × ciclos → votación final → 🏆 Resultados`

1. 🧳 **La máquina:** hace el cambio inicial. Si se puede, nadie repite el cuerpo de la ronda anterior, y en los Inmutables no repite el mismo Inmutable.
2. **Ciclo:**
   - ❓ **La Pregunta:** una pregunta al azar del pool (`apps/server/src/questions.ts`, 30 preguntas). "La Máquina" la publica en **Cotorra 🦜** y respondes desde tu cuerpo, con vista previa de tu post y la fila de quién ya respondió.
   - 🦜 **El Hilo:** cada respuesta sale como post de **Cotorra**, 30 s por post. Todos comentan, dan ❤️ y 🤨 *Sus* ("esto no lo escribiría su dueño"), y se etiquetan con @. "💬 Responder" pone el @ del autor en la caja. Marca ⭐ Top, barra tipo historias y "escribiendo…". El botón de votar pasa al siguiente post.
   - ☀️ **Chat global:** globos planos agrupados, @menciones con autocompletado, **↩ Citar** un post de Cotorra (panel lateral ordenado por ❤️) y cabecitas arriba a la izquierda que se mueven cuando alguien escribe.
   - 🌙 **Chat privado:** cada quien puede *iniciar* pocos DMs (auto: ⌊N/2⌋, entre 2 y 5, contando solo a los activos). Responder es gratis. Bandeja con vista previa del último mensaje, brillo si te escribieron y no contestaste, "escribiendo…" y "Visto ✓✓". Un chat solo se abre al tocarlo.
   - **Votación entre ciclos:** solo si el check está activo, quedan expulsiones disponibles y hay ≥3 activos. **No ocurre en el último ciclo**, porque a ese le sigue la votación final.
   - **Re-cambio:** solo en El Inmutable. Los cambiantes activos se reparten de nuevo los cuerpos que siguen en juego, y nadie se queda en el que tenía. Vuelve a salir la animación de La máquina.
3. **Votación final:** 🧩 ¿Quién es quién? en Clásico y Todos, ⚖️ Juicio Final en los Inmutables.
4. 🏆 **Resultados.** El acumulado se ve en el lobby.

**Ciclos (`cycles`, 0 = Auto):** en Auto el valor se resuelve al empezar y queda en `totalCycles`.
- Clásico / Todos: 1 ciclo. Con la votación entre ciclos activa: 2 ciclos (3 con 9 o más jugadores).
- El Inmutable: `N − 4` ciclos, entre 1 y 3. Cada cambio le descarta un cuerpo a los cambiantes (con *s* cambios quedan N−1−s candidatos), así que *s* ≤ N−4 deja al menos 3 candidatos al Juicio Final.
- El No Cambiante: 2 ciclos, o 3 con 6 o más jugadores.

## Votaciones ✅

| | 🎭 El Desenmascare | 🧩 ¿Quién es quién? | 🗳️ La Votación | ⚖️ Juicio Final |
|---|---|---|---|---|
| Modos | Clásico, Todos | Clásico, Todos | Inmutables | Inmutables |
| Cuándo | Entre ciclos (check) | Final | Entre ciclos (check) | Final |
| Tiempo | `voteSeconds` (30 s) | `guessSeconds` (90 s) | `voteSeconds` (45 s) | `guessSeconds` (90 s) |
| Qué se elige | **Una** acusación, "en el cuerpo X está Y", u Omitir | Cuadrícula completa cuerpo → mente | Un cuerpo u **Omitir** (explícito) | Igual que La Votación |
| Regla | Sale el cuerpo con más acusaciones **correctas** si llega al **60 %** de los activos, sin contar a la mente acusada. Empate arriba = nadie. Máx. 1. | Como antes. Los cuerpos ya expulsados no cuentan. | **Mayoría simple, aunque sea 1 voto.** No votar no cuenta. Empate, u Omitir ≥ máximo = nadie. | Igual. Si no sale el Inmutable, él gana. |
| Conteo | **Oculto** (delataría información) | — | Visible y anónimo | Visible y anónimo |

- **Anuncio (`VERDICT`, 8 s):** "¡El cuerpo de Marcos fue desenmascarado! Adentro estaba Ana", "👻 El cuerpo de Dani ahora es un fantasma", "¡Sacaste al Inmutable!" o "No se sacó a nadie".
- **Fantasma (Inmutables, votación entre ciclos) ✅:** si sale un **cambiante**, **no se revela qué alma tenía**. Revelarla descartaría otra mente que seguro no está en su cuerpo. El cuerpo queda como fantasma y la partida sigue. Se revela cuando sale el Inmutable, en el Juicio Final y en los resultados. En Clásico y Todos, el Desenmascare sí revela la mente, porque ese es el castigo.
- **Reacciones en vivo** en las votaciones y el anuncio: 😂 😭 😊 ❤️ 😡 👏 🤔 👀 🤡. Son solo ambiente, no cuentan como voto, y tienen anti-spam de 150 ms.
- **Expulsión:** sale **el cuerpo** (`bodyOut`, público) **y la mente que tenía adentro**, que pasa a espectador. El dueño original de ese cuerpo sigue jugando desde el cuerpo en el que esté.
  - Desenmascare (y fin de partida): la mente se marca `out` en público.
  - Fantasma: la mente queda en `hiddenOut`, privado del room. En público **nadie** aparece como `out` hasta el final. El cliente sabe que es espectador por `identity.spectator`. Los conteos de activos se calculan por cuerpos (`activeCount`), así cuadran sin delatar a nadie.
- **Espectador:** solo lee el chat público. No escribe, no vota, no recibe DMs y no ve quién es quién hasta los resultados.
- **🕸️ Grafo de chats (espectadores) ✅:** de noche el espectador ve los cuerpos en círculo, con una línea entre cada par que se está escribiendo. La línea se engrosa con los mensajes y destella con cada uno nuevo, y abajo hay una lista "Ana ↔ Beto · 2 mensajes". **Nunca ve el contenido.** El server manda `chatGraph` solo a los espectadores.
- **Fin anticipado (Inmutables):** si sale el Inmutable, ganan los cambiantes; si quedan solo 2 activos, gana el Inmutable.

### Checks del lobby
| Ajuste | Aplica a | Por defecto |
|---|---|---|
| `earlyVote`: votación entre ciclos | todos | apagado. Con menos de 7 jugadores, al activarlo sale el modal "⚠️ Pocos jugadores" (Activar igual / Mejor no). |
| `maxEjections` (0 = sin límite) | todos | Clásico/Todos: 1 · Inmutables: sin límite |
| `unmaskSame`: desenmascarar a quien no cambió | solo Clásico | apagado. Apagado, la opción "🙋 no cambió" no aparece en el selector. |
| `voteSeconds` | votaciones entre ciclos | 30 s en Clásico/Todos, 45 s en Inmutables |
| Tiempos de cada fase (0 = Off), ciclos, chats por noche | todos | como antes |

## Puntos ✅ (`POINTS` en `rules.ts`)

**¿Quién es quién?:**
- +200 por cada cambio descubierto.
- +50 por acertar que alguien no cambió.
- +150 🥷 **Sigilo**: cambiaste y menos de la mitad te descubrió.
- +150 🎭 **Despiste**: no cambiaste y la mitad o más creyó que sí.

**El Desenmascare:**
- +200 a cada acusador correcto y −200 a la mente expuesta.
- Si se desenmascara a alguien que no cambió: +100 a cada acusador y −150 al expuesto.
- Acusar mal u Omitir: 0.

**Inmutables:**
| Situación | Puntos |
|---|---|
| Sale el Inmutable | +150 a cada cambiante (también a los expulsados) y +200 extra a quienes lo votaron |
| Votaste por un cambiante y lo expulsaron | −50 |
| El Inmutable, por cada cambiante expulsado | +100 (y no recibe −50 por votar a un cambiante) |
| El Inmutable, por cada votación entre ciclos que sobrevive | +100 |
| Gana el Inmutable | +500 |
| Expulsan a un cambiante | 0 para el expulsado |

## Resultados

- **Clásico / Todos ✅:**
  1. Revelación cuerpo por cuerpo.
  2. "Tu ronda": tus aciertos y de dónde salió cada punto, incluidos los del Desenmascare (`early`).
  3. Puntos de la ronda.
- **Inmutables ✅:** quién ganó, quién era el Inmutable, expulsiones por ciclo, quién estaba en cada cuerpo al final con su recorrido, y puntos de la ronda.
- **Anuncio de votación ✅:** 1,5 s de suspenso, luego el resultado; el conteo solo aparece en las votaciones de los Inmutables. Si hay ganador sale el banner, y "Eras tú" si te expulsaron.
- **Espectador ✅:** pill "👻 Espectador", chat e hilo de solo lectura, sin likes, grafo de chats de noche, sin votar ni adivinar.

## Reglas técnicas clave

- El mapeo mente→cuerpo y quién es el Inmutable viven **solo en memoria privada del room**, nunca en el schema. Cada cliente recibe solo su propia identidad y su rol (`identity: { mindId, bodyId, role }`).
- En Pregunta, Hilo, Día y Noche se habla con el nombre del **cuerpo**. En el lobby y en resultados, con el nombre real.
- **Reconexión:** con el token (120 s de gracia) o volviendo a entrar con el mismo nombre ("¿eres tú?"). Es inseguro a propósito. Al reconectar se reenvían el historial del chat, los DMs de la noche, el anuncio en curso y los resultados.
- Las reglas puras (mínimos, ciclos Auto, puntos, resolución de votos) están en `apps/server/src/rules.ts`, separadas de `GameRoom.ts`.

- **Sin filtraciones durante la partida:**
  - En los Inmutables el marcador público (`score`) se actualiza **recién al final**. Ver quién sumó tras una votación delataría al Inmutable.
  - En La Pregunta, el "quién ya respondió" es anónimo (✓ / …): mostrar las mentes delataría a los fantasmas, que nunca responden.

## Verificación (26/09/2026)

- Simulación del server con bots: 26 comprobaciones OK.
  - Mínimos por modo con `MIN_PLAYERS=4` ignorado.
  - El No Cambiante sin re-cambio.
  - El Inmutable: re-cambio; 1 voto contra omisiones expulsa; el espectador no vota; fin anticipado al expulsar al Inmutable.
  - Clásico: el Desenmascare expulsa con 3/5 (60 %) y no con 2/5; el conteo no se envía; "no cambió" se rechaza sin el check; puntos −200 / +200.
- Navegador: inicio con 4 modos, lobby con checks y modal, re-cambio, votación con reacciones, anuncio y resultados del Inmutable. Sin errores de consola.

## Decisiones de UI (v2 aprobada, 26/09/2026)

- **Cotorra 🦜** reemplaza el look de X: marca propia (nombre, sello ✦ amarillo, colores del juego, "cotorrear"). Nada de logo, nombre ni check azul de X.
- **Sin premisas narrativas** por ahora ("La Sala", "Los Cuartos"): un chat es un chat, para no saturar de conceptos.
- **Para después:** reacciones a mensajes del chat, subhilos (responder a una respuesta), tema fijado en el chat global.
- **Descartado:** respuestas sugeridas, la encuesta del grupo y la captura filtrada.
- Mockups: `mockups/fases-antes-despues.html` (v1) y `mockups/fases-v2.html` (v2; se implementó todo menos la narrativa y la voz).
- **Voz:** en investigación, sin implementar. Ver `mockups/voz-v3.html`.

## Sin decidir

- ⏳ Darle sentido propio a "Todos cambian".
- ⏳ Quedarnos con El Inmutable o con El No Cambiante después de probar ambos.

## Pendiente conocido

- i18n.
- Historial de DMs de noches anteriores.
- Ampliar el pool de preguntas.

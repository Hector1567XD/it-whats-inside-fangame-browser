# Plan: voces menos reconocibles e imitaciones más creíbles

> **Qué pidió el usuario:**
> 1. Que las voces se distingan menos. No tanto por el tono, sino por las **risas** y las cosas que la gente hace "normalmente" (subidas y bajadas de volumen, etc.) y que delatan a alguien. **Normalizar la voz en tiempo real** para que eso pase menos y el juego sea más de *imitar*.
> 2. Formas de que las **imitaciones sean más certeras**, y a la vez formas de **distorsionar o suavizar** las diferencias entre voces.
>
> **Estado actual (punto de partida):** cada jugador modula su propia voz en su navegador (`apps/web/src/voice/chain.ts`):
> `mic (AEC/NS/AGC del navegador) → motor de tono (Signalsmith → Tone → nativo → robot) → timbre (lowshelf/highshelf) → walkie 0/1/2 → compresor → pista WebRTC`.
> En partida, los parámetros salen del **dueño del cuerpo** (`paramsFor(owner.voice, owner.voiceVariant, miF0)`) y el SFU etiqueta las pistas por **cuerpo**. El motor aplica un desplazamiento **fijo** de semitonos: mueve la media de tu tono al tono del cuerpo, pero conserva intacta tu entonación, tu volumen, tus risas y tu ritmo.
>
> **Prototipo que acompaña este documento:** `mockups/voz-7.html` (nivelador, aplanar entonación, formantes, detector de risas, modo susurro y walkie con estática que solo suena cuando hablas).

---

## 1. Qué delata a alguien (además del tono medio)

Los cambiadores de voz como el nuestro corren la **media** del tono (F0). Pero la gente se reconoce sobre todo por *cómo* varía la voz. Ordenado de más a menos delator en un juego entre amigos:

| # | Rasgo | Por qué delata | ¿Lo cambia hoy la cadena? | ¿Se puede normalizar en vivo? |
|---|---|---|---|---|
| 1 | **Risa** | Es casi una firma: ritmo de "ja-ja" (4–7 Hz), saltos grandes de tono, respiración entre golpes, volumen alto. Es involuntaria: nadie la imita bien. | No (solo se corre el tono). | **Sí, parcial**: detectarla (heurística) y taparla. Siempre se escapa algo del primer golpe, salvo que agreguemos retraso. |
| 2 | **Dinámica de volumen** | Hay quien habla fuerte y quien susurra, quien grita al emocionarse, quien baja la voz al final de la frase. El AGC del navegador es lento y deja pasar casi todo. | Muy poco (un `DynamicsCompressor` con valores por defecto). | **Sí, fácil**: AGC propio + compresión fuerte ("nivelador"). |
| 3 | **Rango de entonación** (varianza de F0) | Personas monótonas y personas "cantarinas". Las subidas al preguntar y las bajadas al terminar son muy personales. | No: el desplazamiento fijo conserva el contorno entero. | **Sí**: detectar F0 por cuadro y mover el pitch shifter en cada cuadro (ver §2.2). |
| 4 | **Envolvente espectral / formantes** | El "color" de la voz (tamaño del tracto vocal, nasalidad). Es lo que queda cuando el tono ya se corrió. | En parte: Signalsmith mueve formantes, más un tilt de ±3 dB. | **Sí**: correr formantes, igualar hacia una plantilla, o McAdams (§2.4). |
| 5 | **Ritmo y pausas** | Velocidad al hablar, "eeeh", muletillas, silencios largos. | No. | **Casi no**: en vivo no se puede acelerar sin acumular retraso. Solo se pueden recortar pausas o tapar muletillas. |
| 6 | **Soplo (breathiness) y voz rasposa (vocal fry)** | Ruido de aire en la voz, crujido en los graves al final de las frases. | No. | **Parcial**: un vocoder de ruido lo borra todo (y el tono también). Un de-esser o un expander de respiraciones lo suaviza. |
| 7 | **Acento, muletillas, vocabulario** | "Wey", "o sea", "¿neta?", la forma de decir los nombres. | No. | **No por señal.** Solo con diseño de juego o con un modo de voz a texto (§2.9). |
| 8 | **Micrófono y cuarto** | Cada celular colorea distinto: graves de audífonos Bluetooth, eco del baño, ruido de ventilador. | No. | **Sí, parcial**: pasa-altos, EQ hacia una curva plana, el walkie que lo iguala todo, y la supresión de ruido del navegador. |

**Conclusión:** para que el juego sea más de imitar hay que atacar primero lo que es *involuntario* (risa, volumen, rango de entonación, micrófono). Así lo que queda es lo que sí se puede imitar a propósito: palabras, actitud y ritmo.

---

## 2. Técnicas de normalización en tiempo real

Todas corren **en el navegador de quien habla**, antes del `MediaStreamDestination`. Así la voz real nunca sale del dispositivo (regla que ya cumple `chain.ts`).

### 2.1 Nivelador: AGC agresivo + compresión (aplanar volumen)

- **Qué hace:** sube lo bajo y baja lo alto. Un susurro y un grito terminan casi al mismo volumen.
- **Cómo (Web Audio nativo, sin worklet):**
  1. `BiquadFilter` pasa-altos a 80–100 Hz: quita el retumbe del micrófono y los golpes.
  2. **AGC lento propio:** un `AnalyserNode` mide el RMS cada ~25 ms en JS. Si hay voz (por encima de una puerta de −50 dBFS), se calcula `ganancia = objetivo − nivel`, limitada a −10…+24 dB, y se suaviza con una constante de 1–3 s: `GainNode.gain.setTargetAtTime(...)`. En silencio **no se sube la ganancia**, para no inflar el ruido.
  3. `DynamicsCompressor` con umbral de −35 dB, ratio 12, ataque de 3 ms, release de 150 ms y ganancia de compensación.
  4. Opcional: un compresor **multibanda** (3 bandas con `BiquadFilter` + 3 `DynamicsCompressor`) para que un grito no suene más brillante que el habla normal. Es barato, pero puede sonar "aplastado".
- **Latencia:** ~0 ms (el compresor nativo tiene un lookahead de ~6 ms). **CPU:** despreciable, incluso en celulares.
- **Cómo medirlo:** la desviación estándar del nivel en dB mientras se habla. En el prototipo baja de ~8–10 dB (entrada) a ~2–4 dB (salida).
- **Riesgo:** bajo. Con ruido de fondo alto el AGC puede "respirar"; se evita con la puerta y con `noiseSuppression` del navegador.

### 2.2 Aplanar la entonación (contorno de F0 comprimido)

- **Idea:** hoy aplicamos `semitonos = objetivo − miMedia` (fijo). En su lugar, por cada cuadro de ~40 ms:

  ```
  f0      = detectar(cuadro)                 // autocorrelación, como pitch.ts
  media   = media móvil de f0 (en semitonos, ~4 s, solo cuadros con voz)
  salida  = objetivo + (f0 − media) · k      // todo en semitonos
  shift   = salida − f0                      // lo que se le manda al pitch shifter
  ```

  - `k = 1`: igual que hoy (natural, solo se mueve la media).
  - `k = 0.5`: la mitad de expresividad.
  - `k = 0`: robot monótono, pero con voz humana.
  - `k > 1`: exagera (sirve para que alguien monótono imite a alguien expresivo, ver §3).
- **Cómo:** `AnalyserNode.getFloatTimeDomainData` (2048 muestras) → `detectF0` en JS → `SignalsmithStretch.schedule({ semitones: shift })` unas 25 veces por segundo, solo si el cambio es de más de 0,05 st. En los cuadros sin voz se **mantiene** el último shift, para no meter saltos en las consonantes.
- **Latencia:** la del motor (Signalsmith, del orden de 50–120 ms según el tamaño de bloque) más ~20–40 ms de desfase entre análisis y aplicación. Ese desfase se nota como un pequeño "portamento" en los cambios rápidos. Se puede compensar retrasando el audio de entrada a Signalsmith (`DelayNode` de ~30 ms), a costa de latencia.
- **CPU:** la autocorrelación completa (2048 × 330 lags) son ~14 M de multiplicaciones por segundo. En celulares conviene **diezmar ×2** (1024 muestras a 24 kHz) o usar YIN o McLeod: ~3–4 M/s, sin problema. Mejor aún, mover todo a un `AudioWorklet` propio.
- **Errores típicos:** los errores de octava (confundir f0 con f0/2) producen saltos de ±12 st. Mitigación: limitar `|f0 − media| ≤ 10 st`, filtro de mediana de 3 cuadros y suavizado del shift.
- **Motores sin control por cuadro:** Tone.js `PitchShift.pitch` también se puede mover por cuadro (con más artefactos). El nativo con delays requiere reconstruir el grafo (no sirve). En el robot, basta con fijar la portadora: ya es monótono (k = 0 gratis).

### 2.3 Formantes hacia una plantilla

- **Qué es:** Signalsmith ya separa el tono de los formantes (`formantSemitones`, `formantCompensation`, `formantBaseHz`). Hoy usamos −2 (masc) / +2,5 (fem) ± variante.
- **Normalizar:** en la calibración del lobby se mide el **centroide espectral** y el tilt del jugador. Con eso se elige `formantSemitones` para llevarlo hacia la plantilla del cuerpo, en lugar de sumar un valor fijo. Una persona de tracto largo y otra de tracto corto terminan más parecidas.
- **Complemento barato:** un EQ de 10–20 bandas `peaking` que copia la diferencia entre el espectro promedio del jugador y el del cuerpo. Es lo que ya prueba `mockups/voz-v6.html` con grabaciones; se puede llevar a vivo sin cambios, porque son filtros estáticos.

### 2.4 McAdams (anonimización por LPC): muy relevante

- **Qué es:** es el *baseline B2* del VoicePrivacy Challenge (Patino et al., 2021). Sirve para anonimizar sin entrenamiento y funciona casi igual que un cambio de formantes "raro". Por cuadro (20–30 ms, con solapamiento):
  1. Análisis **LPC** de orden ~20 (Levinson-Durbin).
  2. Se sacan las **raíces** del polinomio LPC (polos). A cada polo complejo con ángulo φ (0 < φ < π) se le cambia el ángulo por **φ^α**, con el **coeficiente de McAdams α ≈ 0,75–0,9**. La magnitud se conserva, así los anchos de banda de los formantes no cambian.
  3. Se reconstruye el filtro y se re-sintetiza **filtrando el residuo** original (que conserva el tono y el ritmo), con overlap-add.
- **Por qué sirve:** como φ^α no es lineal, **deforma las posiciones relativas de los formantes**: no las corre todas por igual. Esa es justamente la parte del timbre que identifica a la persona. Además, α puede ser **por cuerpo** (por ejemplo 0,78 / 0,82 / 0,86…): cuerpos distintos suenan distinto y dos personas en el mismo cuerpo quedan más parecidas.
- **Viabilidad en navegador:** necesita un `AudioWorklet` propio en JS o WASM. Remuestrear a 16 kHz, cuadros de 20 ms con salto de 10 ms: 100 cuadros/s × (LPC 20 + raíces de un polinomio de grado 20 con Durand-Kerner o autovalores de la matriz compañera). Es muy barato en escritorio y aceptable en celulares de gama media. **Latencia:** ~30–40 ms.
- **Riesgo:** medio. La calidad es "algo metálica" con α < 0,8, y la búsqueda de raíces tiene casos numéricos feos (polos cerca del círculo unidad: hay que acotar la magnitud a ≤ 0,98). No combina bien con Signalsmith en serie (dos procesos por cuadro suman latencia): conviene elegir **uno** de los dos como motor de timbre.

### 2.5 Promediado de envolvente / re-síntesis LPC

- Es la versión más extrema de §2.3: se reemplaza la envolvente espectral del jugador por una **envolvente plantilla del cuerpo**, suavizada en el tiempo, y se aplica al residuo LPC.
- Borra casi todo el timbre personal, pero también parte de la inteligibilidad de las vocales si la plantilla es fija. Una variante intermedia es **mezclar**: `env = (1 − m)·env_jugador + m·env_plantilla`.
- Se puede hacer en el mismo worklet de McAdams: es "ciencia" similar y el mismo costo.

### 2.6 Modo susurro: vocoder de canales excitado con ruido

- **Qué hace:** saca la envolvente de 16 bandas de la voz y la aplica a **ruido**. No queda tono, ni entonación, ni vocal fry, ni soplo propio: **todos susurran igual**. Solo sobreviven las palabras, el ritmo y el volumen (y el volumen ya lo aplana §2.1).
- **Cómo (nativo, sin worklet):** es igual al motor `robot` de `engines.ts`, cambiando la portadora por ruido blanco. Por banda: `bandpass(voz) → WaveShaper |x| → lowpass 25–40 Hz → GainNode → vca.gain`, y `ruido → bandpass → vca`.
- **Latencia:** ~0. **CPU:** 16 × (2 biquads + shaper + biquad), trivial.
- **Uso en el juego:** una **fase o carta "Susurros"** o un nivel máximo de anonimato. Es la herramienta más potente y más barata que tenemos, pero cuesta expresividad.

### 2.7 Quitar el color del micrófono y el cuarto

- **Pasa-altos** de 80–100 Hz (siempre) y **pasa-bajos** de ~7 kHz: los agudos de micrófonos buenos delatan "el de la compu buena".
- **EQ hacia una curva plana:** en la calibración, el espectro promedio del jugador se compara con una curva de habla promedio (tilt de −6 dB/oct aprox.) y se corrige con 8–10 filtros `peaking`, limitados a ±6 dB. Es el mismo método que `voz-v6`, con el objetivo "voz promedio" en vez de "dueño".
- **Reverberación:** una de-reverberación de verdad (WPE, etc.) es cara. Lo práctico es un **expander o puerta** que corte las colas en las pausas, más la `noiseSuppression` del navegador (que ya reduce algo el eco).
- **El walkie como igualador:** el pasa-banda de 300–3.400 Hz, más saturación, más estática, borra justo lo que distingue a los micrófonos. Hoy el nivel 2 mete estática **fija** a −35 dB; es mejor que la estática **solo suene cuando hablas** (con un seguidor de envolvente que maneja la ganancia del ruido). Queda más creíble como radio y no molesta en los silencios. Está implementado en el prototipo.

### 2.8 Risas: detección heurística y qué hacer

**Detección** (cada ~25 ms, sobre la ventana de ~1,2 s anterior; no necesita ML):

| Rasgo | Medida | Por qué |
|---|---|---|
| Periodicidad del volumen | Autocorrelación de la envolvente en dB en retardos de 125–250 ms (4–8 Hz) | "ja-ja-ja" es mucho más regular que las sílabas del habla. |
| Profundidad de modulación | p90 − p10 del nivel en la ventana > ~12 dB | Los golpes de risa van de casi silencio a fuerte. |
| Alternancia sonora/sorda | Cambios voz/no-voz por segundo (≥ 4–5) | "h" (aire) + "a" (voz) en cada golpe. |
| Tono elevado | Mediana de F0 en la ventana − media larga > +3 st | Al reír el tono sube mucho. |

`score = 0,35·periodicidad + 0,25·profundidad + 0,2·alternancia + 0,2·tono`, con histéresis (entra en > umbral, sale en < umbral − 0,15, y se mantiene 400 ms).
**Realista:** con esto se detecta la mayoría de las carcajadas claras. Falla con risas cortas ("jeje" de dos golpes), risas nasales calladas y con gente que habla muy rítmico. Los falsos positivos se notan poco si la acción es suave.

**Qué hacer al detectar** (seleccionable por el host):

| Acción | Efecto | Nota |
|---|---|---|
| Nada | — | Para comparar. |
| Bajar volumen (duck a −15 dB) | La risa se oye lejos. | La más segura contra falsos positivos. |
| Robotizar | Ring-mod o vocoder solo durante la risa. | Se nota que "algo pasó", pero no quién ríe. |
| **Reemplazar por risa enlatada del CUERPO** | Se silencia la voz y suena una risa sintetizada (o un sample) con el tono del cuerpo. | La más divertida: todos los cuerpos "ríen igual que su dueño". Hay que cuidar que suene a juego y no a bug. |

**El problema del primer golpe:** la heurística necesita ~0,3–0,6 s para decidir, y ese primer "JA" sale sin tapar. La solución es un **retraso de seguridad** (lookahead): se retrasa el audio saliente 300–500 ms con un `DelayNode` mientras el análisis corre sobre el audio sin retrasar. Cuesta latencia de conversación, así que sirve para el modo "anonimato alto" o para fases donde se habla por turnos, no para charla rápida. En el prototipo es un slider.

**Risa enlatada por cuerpo:** en el lobby se le puede pedir a cada jugador que grabe "una risa" (opcional). Solo se guarda **procesada con la voz de su cuerpo** y se usa cuando otro ríe en ese cuerpo. Sin grabación, se usa una sintetizada: 4–5 sílabas "ha" a ~5 Hz (sierra con formante de "a" más un soplo de ruido en cada golpe, con el tono bajando), afinada al tono del cuerpo.

### 2.9 Respiraciones y muletillas

- **Respiraciones:** un expander o puerta con la condición "ruido de banda ancha sin F0 y nivel bajo" (> 200 ms) baja 12 dB. Es barato y quita un rasgo personal (hay quien respira muy fuerte).
- **Muletillas ("eeeh", "mmm"):** son vocales sostenidas con F0 plano y energía constante (> 400 ms). Se pueden detectar y bajar, pero hay falsos positivos con vocales largas normales. Prioridad baja.
- **Acento y vocabulario:** no se arreglan con señal. Opciones de diseño:
  - **Modo telegrama (voz → texto → voz):** reconocimiento de voz (Web Speech API; en Chrome manda el audio a Google, y hay que avisar) → se envía **solo el texto** → cada receptor lo sintetiza con `speechSynthesis` con la voz del **cuerpo**. Borra todo menos las palabras. Latencia de 1–2 s. `speechSynthesis` no se puede capturar en Web Audio, por eso se sintetiza en el receptor. Como modo o carta de juego, no como voz por defecto.

### 2.10 Opciones con ML (a futuro)

| Opción | Qué hace | Navegador | Latencia | Veredicto |
|---|---|---|---|---|
| **RVC / so-vits-svc** | Conversión a una voz objetivo entrenada (HuBERT/ContentVec + decoder). | Modelos de 50–200 MB; ONNX Runtime Web con WebGPU **solo en escritorio con GPU decente**. En celulares, no. | 150–400 ms en el mejor caso. | Suena muy bien, pero pesa demasiado para un party game en celulares. Además requiere modelos de voces objetivo (genéricas, no de los jugadores). |
| **LLVC** (Koe.ai, 2023) | Conversión *streaming* de cualquier voz a **una** voz objetivo, modelo chico. | Según sus autores corre en tiempo real en CPU de escritorio con < 20 ms de latencia de algoritmo. Habría que exportarlo a ONNX y probar WASM-SIMD. | Baja. | **La opción ML más prometedora**: "todos hablan con la voz del cuerpo" de verdad. Necesita un modelo por voz de cuerpo (5–10 voces genéricas). No está probado en navegador: es un spike de investigación. |
| **StreamVC** (Google, 2024) | Conversión en tiempo real pensada para celulares. | Pesos no publicados. | — | Referencia; no está disponible. |
| **Anonimización por x-vector** (VoicePrivacy B1) | Reemplaza el embedding de hablante y re-sintetiza. | Pipeline pesado (ASR + TTS neural). | Segundos. | No es para tiempo real. |
| **Verificación de "¿se parece?"** | Un embedding de hablante chico (ECAPA-TDNN ONNX, ~20 MB) para **medir** qué tan distinguibles quedan dos jugadores tras el procesamiento. | Sí, fuera de línea (en el lobby, o en pruebas nuestras). | No importa. | Útil como **herramienta de ajuste**, no dentro de la cadena. |

---

## 3. Imitaciones más certeras: transferencia de estadísticas

**Objetivo:** que quien está en el cuerpo de Ana suene **más a Ana**, no solo "voz femenina 2". No se copia su voz real: se copia su **estilo medible**. El mapeo lo hace el navegador del impostor.

### 3.1 La huella del cuerpo (se captura en el lobby)

Durante la calibración (ampliarla de 3 s a ~6–8 s de habla libre, o leer una frase) se mide:

| Estadística | Cómo | Tamaño |
|---|---|---|
| F0 mediana | autocorrelación (ya existe: `medianF0`) | 1 número |
| Rango de F0 | percentiles 10–90 en semitonos (o desviación estándar) | 2 números |
| Centroide y tilt espectral | FFT promedio de cuadros con voz (como `voz-v6`) | 1–2 números |
| Envolvente en 20 bandas | dB normalizado (como `voz-v6`) | 20 números |
| Dinámica de volumen | desviación estándar del nivel en dB mientras habla, más picos | 2 números |
| Ritmo | picos de envolvente por segundo (≈ sílabas/s) y fracción de pausa | 2 números |

Todo cabe en **< 300 bytes**. `voz-v6.html` ya genera casi esta huella (`{ f0, f0lo, f0hi, centroid, bands }`).

### 3.2 El mapeo (en el navegador del impostor)

El impostor también tiene su huella propia (local, **nunca se envía**) y una estadística **en vivo** que se actualiza mientras habla.

| Rasgo | Mapeo | Dónde se aplica |
|---|---|---|
| Tono medio | `shift = f0_dueño − media_impostor` (lo que ya hacemos) | Signalsmith `semitones` |
| **Rango de entonación** | `k = rango_dueño / rango_impostor` en la fórmula de §2.2 (limitado a 0,3–1,8) | Signalsmith por cuadro |
| Timbre | EQ = `bandas_dueño − bandas_impostor` (limitado a ±12 dB, suavizado) | 20 `peaking` (voz-v6) |
| Formantes | `formantSemitones` por la razón de centroides | Signalsmith |
| **Dinámica de volumen** | Con el nivelador se aplana la dinámica del impostor, y luego un **expansor o compresor** re-aplica la dinámica del dueño (ratio que lleve la desviación estándar de dB al valor del dueño) | Compresor + ganancia por JS |
| Ritmo | **No se toca** en vivo (el impostor tiene que imitarlo: es parte del juego). Se puede **mostrar** como pista: "Ana habla rápido". | UI |

- Todo con un slider de **"Parecido 0–100 %"** (como `voz-v6`), que interpola entre "voz del preset" y "estilo del dueño".
- **Ojo con el equilibrio:** si el mapeo es perfecto, adivinar se vuelve imposible y el juego pierde gracia. Por eso el parecido y el anonimato son perillas del host (§5), no valores fijos.

### 3.3 Anonimizar e imitar a la vez

Parece contradictorio, pero es la misma cadena en dos pasos:

1. **Normalizar al impostor** (quitar lo suyo): nivelador, rango de F0 comprimido (k bajo), EQ hacia una curva promedio, risas tapadas.
2. **Re-aplicar el estilo del dueño** (poner lo del cuerpo): media y rango de F0 del dueño, su tilt y su dinámica.

Así, quien esté en el cuerpo de Ana suena "a la Ana procesada". El dueño original en su propio cuerpo también pasa por los dos pasos (normalizar y re-aplicar su propia huella). Así **nadie suena "más natural" en su cuerpo**, algo que hoy delataría a quien no cambió de cuerpo.

### 3.4 Privacidad y fugas de identidad (reglas duras)

1. **El server nunca revela qué mente está en qué cuerpo.** Todo el procesamiento que depende de la mente (tu huella, tus estadísticas en vivo, el mapeo) se hace en **tu** navegador. Al server solo le llega lo que depende del **cuerpo**.
2. **La huella del dueño es un dato del cuerpo**, y se sabe de quién es cada cuerpo. Se puede repartir etiquetada por cuerpo. Aun así:
   - Se manda **cuantizada** (F0 redondeado a 5 Hz, bandas a 1 dB) y **relativa al preset**, no en crudo. Sirve para imitar, pero no es un perfil biométrico.
   - Nunca se envían audios crudos; la risa grabada del lobby se guarda ya procesada.
   - La huella del impostor **nunca** se envía.
3. **Fugas por tiempo:** al intercambiar cuerpos, **todos** los clientes cambian parámetros en el mismo instante, marcado por el server (por ejemplo, al empezar la fase), y con rampas (`setTargetAtTime`). Si solo "hipan" los que cambiaron, se delatan. Se aplica también a cargar o reiniciar motores: no reconstruir la cadena en el cambio de cuerpo, solo mover parámetros.
4. **Fugas por metadatos:** el SFU ya etiqueta las pistas por cuerpo (con época). No mandar al server ni a otros clientes ningún indicador de "motor en uso", "estadísticas convergiendo" o "risa detectada" asociado a la mente. Si se muestra "🙊 risa tapada", que sea por cuerpo y solo en la UI local del receptor.
5. **Convergencia del mapeo:** las estadísticas en vivo del impostor tardan unos segundos en estabilizarse. Hay que arrancar desde la huella local del lobby (no desde cero), así la voz no "cambia" audiblemente durante los primeros segundos de cada fase.

---

## 4. Latencia y CPU (presupuesto)

| Etapa | Latencia añadida | CPU (celular gama media) | Sin worklet |
|---|---|---|---|
| Nivelador (AGC + compresor) | ~6 ms | muy baja | ✔ |
| EQ de color/timbre (10–20 biquads) | 0 | baja | ✔ |
| Signalsmith (tono + formantes) | ~50–120 ms | media (WASM) | ✖ |
| Aplanar entonación (detección F0 en JS) | +20–40 ms de desfase (no suma al audio) | baja-media (diezmado) | ✔ (el análisis) / ✖ (el shift) |
| McAdams (worklet propio) | ~30–40 ms | media | ✖ |
| Detector de risas | 0 (o el lookahead elegido: 0–500 ms) | muy baja | ✔ |
| Susurro (vocoder de 16 bandas) | ~0 | baja | ✔ |
| Walkie con estática controlada por la voz | 0 | muy baja | ✔ |
| Opus + red (SFU) | ~60–150 ms | — | — |
| ML (LLVC/RVC) | 20–400 ms | alta / imposible | ✖ |

**Regla práctica:** la latencia total boca-oído debería quedar **< 300 ms** para que la charla siga fluida. Signalsmith más la red ya usan ~200 ms. Por eso el lookahead de risas solo va en "anonimato alto".

---

## 5. "Nivel de anonimato" (ajuste del host)

Propuesta: una sola perilla visible, con presets, más "avanzado" desplegable.

| Parámetro | Bajo | Medio (default) | Alto | Máximo |
|---|---|---|---|---|
| Nivelador | suave (ratio 4) | fuerte (ratio 12, AGC 2 s) | fuerte + multibanda | igual que alto |
| Entonación `k` | 1,0 | 0,6 | 0,35 | — (susurro) |
| Formantes | preset | preset + normalización | McAdams α por cuerpo | — |
| Color de mic (EQ plano) | off | on | on | on |
| Risas | nada | bajar volumen | risa enlatada del cuerpo | risa enlatada + lookahead de 300 ms |
| Respiraciones | off | off | expander | expander |
| Susurro | off | off | off | **on** |
| Walkie | lo que elija el host (off / poquito / distorsión / radio) | | | radio |
| Parecido al dueño (§3) | 0 % | 50 % | 80 % | n/a |

En `Settings` serían `voiceAnon: 0–3` y `voiceLikeness: 0–100`, más los overrides avanzados si hacen falta (`voiceLaugh: "none" | "duck" | "robot" | "canned"`). Todos los clientes aplican lo mismo, porque se deriva del estado. Así nadie suena distinto por su configuración.

---

## 6. Roadmap priorizado

### Ya (victorias rápidas: 1–3 días en total, riesgo bajo)

| # | Qué | Esfuerzo | Riesgo | Notas |
|---|---|---|---|---|
| 1 | **Nivelador** (pasa-altos + AGC propio + compresor fuerte) en `Pipeline`, antes del motor | 0,5 día | bajo | El mayor impacto por esfuerzo en "subidas y bajadas". |
| 2 | **Walkie con estática que solo suena al hablar**, y separar "Distorsión" (sin estática) de "Radio" | 0,5 día | bajo | Pasa de 0–2 a 0–3; la reconexión sin renegociar ya existe. |
| 3 | **Detector de risas + bajar volumen** (sin lookahead) | 1 día | medio (falsos positivos) | Primero solo "duck"; medir en partidas reales. |
| 4 | **Modo susurro** como opción del host | 0,5 día | bajo | Reusa el motor `robot` con portadora de ruido. |

### Pronto (medio: 1–2 semanas)

| # | Qué | Esfuerzo | Riesgo | Notas |
|---|---|---|---|---|
| 5 | **Aplanar entonación** (F0 por cuadro → Signalsmith, con slider `k`) | 2–3 días | medio | Mover la detección a un `AudioWorklet` para no depender del hilo principal (los timers se frenan en pestañas en segundo plano). En Tone.js degradar a `k = 1`. |
| 6 | **Huella de cuerpo ampliada** (rango F0, bandas, dinámica) y **mapeo de estadísticas** con "Parecido" | 3–4 días | medio | Cumplir §3.4 (cuantizar, por cuerpo, cambios sincronizados). |
| 7 | **EQ plano de color de mic** en la calibración | 1 día | bajo | Reusa el análisis de `voz-v6`. |
| 8 | **Risa enlatada por cuerpo** (sintética, luego grabada y procesada en el lobby) + lookahead opcional | 2 días | medio | Cuidar que suene a "gag" del juego. |

### Ambicioso (después)

| # | Qué | Esfuerzo | Riesgo | Notas |
|---|---|---|---|---|
| 9 | **McAdams en `AudioWorklet`** (LPC + raíces, α por cuerpo) como motor de timbre alternativo | 1 semana | medio-alto | Calidad por validar; medir distinguibilidad con un embedding de hablante (ECAPA ONNX) fuera de línea. |
| 10 | **Modo telegrama** (voz → texto → TTS con la voz del cuerpo en el receptor) | 1 semana | medio | Aviso de privacidad por Web Speech API; como carta o fase especial. |
| 11 | **Spike LLVC en navegador** (ONNX + WASM-SIMD o WebGPU) con 5–10 voces de cuerpo | 2+ semanas | alto | Solo si 1–9 no bastan. En celulares, casi seguro que no. |

---

## 7. Cómo validar que "se distinguen menos"

1. **Prueba ciega entre amigos:** 4–6 personas graban la misma frase y una risa. Se procesan con cada nivel de anonimato. Otros tienen que emparejar audio con persona. Métrica: el porcentaje de aciertos debería bajar hacia el azar a medida que sube el nivel.
2. **Métrica objetiva (opcional):** similitud coseno de embeddings de hablante (ECAPA-TDNN) entre personas, antes y después. Si dos personas distintas quedan más cerca entre sí que antes, vamos bien.
3. **Inteligibilidad:** que se sigan entendiendo las palabras (si no se entienden, el nivel es demasiado alto). Una prueba rápida es dictar 10 palabras.
4. **Latencia:** medir boca-oído con dos dispositivos (aplauso grabado). Objetivo < 300 ms.
5. **CPU en celular:** Chrome Android con `chrome://inspect` → Performance. Sin *underruns* (clics) con la cadena completa.

---

## 8. Resumen

- Lo que más delata **no es el tono**: son la **risa**, la **dinámica de volumen** y el **rango de entonación**. Las tres se pueden atacar hoy en el navegador, sin ML y con poca latencia (nivelador, `k` de entonación, detector de risas).
- Para **imitar mejor**, la misma cadena primero **normaliza** al impostor y luego **re-aplica las estadísticas del dueño** (media y rango de F0, timbre, dinámica). Todo con perillas del host: si el disfraz es perfecto, se acaba el juego.
- **Privacidad:** lo de la mente se queda en tu navegador; al server solo le llega lo del cuerpo, cuantizado, y los cambios de cuerpo se aplican a todos a la vez.
- Prueba todo esto con el micrófono en `mockups/voz-7.html`.

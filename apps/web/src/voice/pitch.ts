/** Tono base (F0) de una grabación: mediana de la autocorrelación por cuadros. 0 si no se detecta. */
export function medianF0(buffer: AudioBuffer) {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const N = 2048;
  const found: number[] = [];
  for (let start = 0; start + N < data.length; start += N / 2) {
    const f = detectF0(data.subarray(start, start + N), sr);
    if (f) found.push(f);
  }
  if (found.length < 5) return 0;
  found.sort((a, b) => a - b);
  return found[Math.floor(found.length / 2)];
}

/** F0 de un cuadro por autocorrelación (70–400 Hz). 0 si es silencio o no hay periodicidad clara. */
export function detectF0(buf: Float32Array, rate: number) {
  let energy = 0;
  for (const v of buf) energy += v * v;
  if (Math.sqrt(energy / buf.length) < 0.015) return 0;
  const minLag = Math.floor(rate / 400);
  const maxLag = Math.floor(rate / 70);
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < buf.length - lag; i++) sum += buf[i] * buf[i + lag];
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return best / energy > 0.35 && bestLag ? rate / bestLag : 0;
}

const dec = new Float32Array(1024);
/**
 * F0 de un cuadro de 2048 muestras, rápido (diezmado ×2, autocorrelación normalizada, 70–400 Hz), para medir
 * en vivo ~40 veces por segundo. Toma el primer pico que llegue al 85 % del máximo (evita errores de octava).
 * 0 si no hay voz clara. Igual que en mockups/voz-7.html.
 */
export function detectF0Live(buf: Float32Array, rate: number) {
  const n = dec.length;
  const r = rate / 2;
  let e = 0;
  for (let i = 0; i < n; i++) {
    const v = (buf[2 * i] + buf[2 * i + 1]) * 0.5;
    dec[i] = v;
    e += v * v;
  }
  if (Math.sqrt(e / n) < 0.008) return 0;
  const minLag = Math.floor(r / 400);
  const maxLag = Math.floor(r / 70);
  const nsdf = new Float32Array(maxLag + 2);
  let best = 0;
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let acf = 0;
    let m = 0;
    for (let i = 0; i < n - lag; i++) {
      const a = dec[i];
      const b = dec[i + lag];
      acf += a * b;
      m += a * a + b * b;
    }
    nsdf[lag] = m > 0 ? (2 * acf) / m : 0;
    if (lag <= maxLag && nsdf[lag] > best) best = nsdf[lag];
  }
  if (best < 0.55) return 0;
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    if (nsdf[lag] >= 0.85 * best && nsdf[lag] >= nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1]) {
      const a = nsdf[lag - 1];
      const b = nsdf[lag];
      const c = nsdf[lag + 1];
      const shift = (a - c) / (2 * (a - 2 * b + c) || 1); // interpolación parabólica
      return r / (lag + Math.min(0.5, Math.max(-0.5, shift)));
    }
  }
  return 0;
}

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

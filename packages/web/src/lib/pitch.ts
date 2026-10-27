/**
 * YIN pitch detection (de Cheveigné & Kawahara, 2002), tuned for guitar and bass:
 * 30–1200 Hz. Returns null when the signal is too quiet or not periodic.
 */
export function detectPitch(buf: Float32Array, sampleRate: number, threshold = 0.12): { freq: number; clarity: number } | null {
  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.008) return null;

  const minTau = Math.floor(sampleRate / 1200);
  const maxTau = Math.min(Math.floor(sampleRate / 30), Math.floor(buf.length / 2));
  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < maxTau; i++) {
      const delta = buf[i] - buf[i + tau];
      sum += delta * delta;
    }
    d[tau] = sum;
  }
  // cumulative mean normalized difference
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += d[tau];
    cmnd[tau] = running ? (d[tau] * tau) / running : 1;
  }
  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= maxTau && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;
  // parabolic interpolation for sub-sample accuracy
  const x0 = tau > 1 ? cmnd[tau - 1] : cmnd[tau];
  const x2 = tau < maxTau ? cmnd[tau + 1] : cmnd[tau];
  const denom = 2 * (2 * cmnd[tau] - x2 - x0);
  const better = denom ? tau + (x2 - x0) / denom : tau;
  return { freq: sampleRate / better, clarity: 1 - cmnd[tau] };
}

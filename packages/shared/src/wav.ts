// WAV reading/writing and simple resampling, used for impulse responses and exports.

export interface DecodedWav {
  sampleRate: number;
  /** one Float32Array per channel */
  channels: Float32Array[];
}

export class WavError extends Error {}

export function decodeWav(bytes: Uint8Array): DecodedWav {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new WavError('Not a WAV file.');
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: { off: number; len: number } | null = null;
  for (let o = 12; o + 8 <= bytes.length;) {
    const id = tag(o), size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      data = { off: body, len: Math.min(size, bytes.length - body) };
    }
    o = body + size + (size & 1);
  }
  if (!fmt || !data) throw new WavError('The WAV file has no audio data.');
  const { format, channels: nc, rate, bits } = fmt;
  if (nc < 1 || nc > 8) throw new WavError('Unsupported channel count.');
  const bps = bits / 8;
  const frames = Math.floor(data.len / (bps * nc));
  const out = Array.from({ length: nc }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nc; c++) {
      const o = data.off + (i * nc + c) * bps;
      let v: number;
      if (format === 3 && bits === 32) v = dv.getFloat32(o, true);
      else if (format === 3 && bits === 64) v = dv.getFloat64(o, true);
      else if (format === 1 && bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (format === 1 && bits === 24) {
        let x = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
        if (x & 0x800000) x -= 0x1000000;
        v = x / 8388608;
      } else if (format === 1 && bits === 32) v = dv.getInt32(o, true) / 2147483648;
      else if (format === 1 && bits === 8) v = (bytes[o] - 128) / 128;
      else throw new WavError(`Unsupported WAV encoding (format ${format}, ${bits} bit).`);
      out[c][i] = v;
    }
  }
  return { sampleRate: rate, channels: out };
}

/** 16-bit PCM or 32-bit float WAV from channel data */
export function encodeWav(channels: Float32Array[], sampleRate: number, float = false): Uint8Array {
  const nc = channels.length, frames = channels[0]?.length ?? 0;
  const bps = float ? 4 : 2;
  const dataLen = frames * nc * bps;
  const buf = new Uint8Array(44 + dataLen);
  const dv = new DataView(buf.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, float ? 3 : 1, true); dv.setUint16(22, nc, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * nc * bps, true); dv.setUint16(32, nc * bps, true); dv.setUint16(34, bps * 8, true);
  w(36, 'data'); dv.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < frames; i++) for (let c = 0; c < nc; c++) {
    const v = channels[c][i];
    if (float) dv.setFloat32(o, v, true);
    else dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(v * 32767))), true);
    o += bps;
  }
  return buf;
}

/** Cubic resampling, good enough for impulse responses and previews (not for program audio). */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = to / from;
  const n = Math.max(1, Math.ceil(input.length * ratio));
  const out = new Float32Array(n);
  const s = (i: number) => (i < 0 || i >= input.length ? 0 : input[i]);
  // band-limit when downsampling with a short moving average
  for (let i = 0; i < n; i++) {
    const pos = i / ratio, k = Math.floor(pos), x = pos - k;
    const p0 = s(k - 1), p1 = s(k), p2 = s(k + 1), p3 = s(k + 2);
    out[i] = p1 + 0.5 * x * (p2 - p0 + x * (2 * p0 - 5 * p1 + 4 * p2 - p3 + x * (3 * (p1 - p2) + p3 - p0)));
  }
  return out;
}

/**
 * Prepares an impulse response for the engine: first channel (or the average), resampled,
 * trimmed of trailing silence, capped in length and normalised to unit energy.
 */
export function prepareIr(wav: DecodedWav, sampleRate: number, maxSeconds = 1): Float32Array {
  const nc = wav.channels.length;
  let mono = wav.channels[0];
  if (nc > 1) {
    mono = new Float32Array(mono.length);
    for (const ch of wav.channels) for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / nc;
  }
  let ir = resample(mono, wav.sampleRate, sampleRate);
  let peak = 0;
  for (const v of ir) peak = Math.max(peak, Math.abs(v));
  let end = ir.length;
  while (end > 1 && Math.abs(ir[end - 1]) < peak * 1e-4) end--;
  end = Math.min(end, Math.round(maxSeconds * sampleRate));
  ir = ir.slice(0, Math.max(1, end));
  let energy = 0;
  for (const v of ir) energy += v * v;
  if (energy > 0) {
    const g = 1 / Math.sqrt(energy);
    for (let i = 0; i < ir.length; i++) ir[i] *= g;
  }
  return ir;
}

import { useEffect, useRef, useState } from 'react';
import { frequencyToMidi, noteName, noteNameWithOctave } from '@fretforge/shared';
import { detectPitch } from '../lib/pitch';
import { Icon } from '../components/icons';

/** Chromatic tuner from the microphone or an audio interface input. tuning: highest string first. */
export function Tuner({ tuning, tuningLabel, referencePitch, onClose }: { tuning: number[]; tuningLabel: string | null; referencePitch: number; onClose: () => void }) {
  const [reading, setReading] = useState<{ midi: number; cents: number; freq: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(() => { try { return localStorage.getItem('ff-tuner-device') || ''; } catch { return ''; } });
  const smooth = useRef<number[]>([]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let alive = true;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        if (!alive) return;
        const list = await navigator.mediaDevices.enumerateDevices();
        setDevices(list.filter((d) => d.kind === 'audioinput'));
        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 4096;
        src.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        let last = 0;
        const tick = (t: number) => {
          raf = requestAnimationFrame(tick);
          if (t - last < 50) return;
          last = t;
          analyser.getFloatTimeDomainData(buf);
          const p = detectPitch(buf, ctx!.sampleRate);
          if (!p || p.clarity < 0.85) return;
          const m = frequencyToMidi(p.freq, referencePitch);
          smooth.current = [...smooth.current.slice(-4), m];
          const sorted = [...smooth.current].sort((a, b) => a - b);
          const med = sorted[Math.floor(sorted.length / 2)];
          const midi = Math.round(med);
          setReading({ midi, cents: Math.round((med - midi) * 100), freq: p.freq });
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        const name = (e as { name?: string }).name;
        setError(name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it for Fretforge and reopen the tuner.' : name === 'NotFoundError' ? 'No microphone or audio input was found.' : 'The tuner couldn’t open your audio input.');
      }
    })();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close();
    };
  }, [deviceId, referencePitch]);

  const inTune = reading && Math.abs(reading.cents) <= 4;
  const gaugeLeft = reading ? 50 + Math.max(-50, Math.min(50, reading.cents)) : 50;
  const targets = [...tuning].reverse(); // low string first for display

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Tuner" onClick={(e) => e.stopPropagation()}>
        <header><h2>Tuner</h2><button className="iconbtn" onClick={onClose} aria-label="Close tuner">{Icon.close()}</button></header>
        {error ? <div className="error">{error}</div> : (
          <div className="tuner">
            <div className="note" style={{ color: inTune ? 'var(--good)' : undefined }}>{reading ? noteName(reading.midi) : '–'}</div>
            <div className="cents">{reading ? `${reading.cents > 0 ? '+' : ''}${reading.cents} cents · ${reading.freq.toFixed(1)} Hz` : 'Play a single string'}</div>
            <div className="gauge" aria-hidden="true"><div className="mid" /><i style={{ left: `calc(${gaugeLeft}% - 2px)`, background: inTune ? 'var(--good)' : undefined }} /></div>
            {targets.length > 0 && (
              <>
                <div className="muted" style={{ fontSize: 13 }}>{tuningLabel ?? 'This track'}: tune each string to</div>
                <div className="strings">
                  {targets.map((m, i) => <span key={i} className={reading && reading.midi === m && inTune ? 'hit' : ''}>{noteNameWithOctave(m)}</span>)}
                </div>
              </>
            )}
          </div>
        )}
        {devices.length > 1 && (
          <label className="field"><span>Input</span>
            <select id="tuner-device" value={deviceId} onChange={(e) => { setDeviceId(e.target.value); try { localStorage.setItem('ff-tuner-device', e.target.value); } catch { /* ignore */ } }}>
              <option value="">Default input</option>
              {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Audio input'}</option>)}
            </select>
          </label>
        )}
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>Reference A4 = {referencePitch} Hz (change it in Settings).</p>
      </div>
    </div>
  );
}

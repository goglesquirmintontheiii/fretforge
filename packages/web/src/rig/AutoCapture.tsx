// Automated capture: record your guitar (DI) until you stop, wait a moment while you re-patch,
// play the DI out to your amp or pedal and record what comes back on the same input. The pair
// is lined up and trained into a NAM model in the AI worker.
import { useEffect, useRef, useState } from 'react';
import { encodeWav, NAM_ROLES, formatTime, type NamRole } from '@fretforge/shared';
import { api } from '../api';
import { useApp } from '../lib/app';
import { audioContext } from '../audio/engine';
import { useLive } from './LiveRig';
import { useRigFiles } from '../components/AmpEditor';
import { Icon } from '../components/icons';

type Phase = 'setup' | 'recording' | 'waiting' | 'reamping' | 'review' | 'uploading';
const MARKERS = 3, MARKER_SPACING = 0.5;

function joinChunks(cs: Float32Array[]): Float32Array {
  const out = new Float32Array(cs.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of cs) { out.set(c, o); o += c.length; }
  return out;
}
const peakOf = (x: Float32Array) => { let p = 0; for (let i = 0; i < x.length; i += 3) p = Math.max(p, Math.abs(x[i])); return p; };
const dbfs = (p: number) => (p > 0 ? 20 * Math.log10(p) : -120);

export function AutoCapture({ aiReady, aiReason, onStarted }: { aiReady: boolean; aiReason?: string; onStarted(): void }) {
  const { toast } = useApp();
  const live = useLive();
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [inputId, setInputId] = useState('');
  const [channel, setChannel] = useState(0);
  const [outputId, setOutputId] = useState('');
  const [waitSecs, setWaitSecs] = useState(2);
  const [phase, setPhase] = useState<Phase>('setup');
  const [secs, setSecs] = useState(0);
  const [level, setLevel] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [name, setName] = useState('');
  const [setting, setSetting] = useState('');
  const files = useRigFiles() ?? [];
  const deviceNames = [...new Set(files.filter((f) => f.device).map((f) => f.device!))];
  const [role, setRole] = useState<NamRole>('amp');
  const [epochs, setEpochs] = useState(100);
  const [result, setResult] = useState<{ played: Float32Array; returned: Float32Array; sr: number } | null>(null);
  const rt = useRef<{ ctx: AudioContext; stream: MediaStream; tap: AudioWorkletNode; chunks: { t: number; di: Float32Array }[]; source?: AudioBufferSourceNode; prevSink?: string } | null>(null);
  const di = useRef<Float32Array | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    const list = () => navigator.mediaDevices?.enumerateDevices().then((d) => {
      setInputs(d.filter((x) => x.kind === 'audioinput'));
      setOutputs(d.filter((x) => x.kind === 'audiooutput'));
    }).catch(() => {});
    list();
    navigator.mediaDevices?.addEventListener?.('devicechange', list);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', list);
  }, []);
  useEffect(() => () => { cancelled.current = true; void teardown(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const teardown = async () => {
    const r = rt.current;
    rt.current = null;
    if (!r) return;
    try { r.source?.stop(); } catch { /* not started */ }
    r.stream.getTracks().forEach((t) => t.stop());
    r.tap.disconnect();
    r.tap.port.close();
    const sinkCtx = r.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (r.prevSink !== undefined && sinkCtx.setSinkId) await sinkCtx.setSinkId(r.prevSink).catch(() => {});
  };

  const open = async () => {
    // the live rig would send your guitar to the same output: stop it while capturing
    if (live.running) { await live.stop(); toast('The live rig is off while capturing.'); }
    const ctx = await audioContext();
    await ctx.resume();
    const sinkCtx = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };
    const prevSink = typeof sinkCtx.sinkId === 'string' ? sinkCtx.sinkId : undefined;
    if (outputId && sinkCtx.setSinkId) await sinkCtx.setSinkId(outputId).catch(() => toast('This browser can’t choose the output; the default output is used.'));
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: inputId ? { exact: inputId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
    });
    const src = ctx.createMediaStreamSource(stream);
    const g = ctx.createGain();
    g.channelCount = 1; g.channelCountMode = 'explicit'; g.channelInterpretation = 'discrete';
    if (channel > 0) { const sp = ctx.createChannelSplitter(2); src.connect(sp); sp.connect(g, 1, 0); } else src.connect(g);
    const tap = new AudioWorkletNode(ctx, 'ff-tap', { numberOfInputs: 3, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    g.connect(tap, 0, 0);
    const r = { ctx, stream, tap, chunks: [] as { t: number; di: Float32Array }[], prevSink };
    tap.port.onmessage = (e) => {
      const m = e.data as { t: number; di: Float32Array };
      r.chunks.push({ t: m.t, di: m.di });
      setLevel((l) => Math.max(peakOf(m.di), l * 0.85));
    };
    rt.current = r;
    return r;
  };

  const startRecording = async () => {
    try {
      cancelled.current = false;
      const r = await open();
      r.chunks = [];
      setPhase('recording');
      setSecs(0);
      const t0 = performance.now();
      const timer = window.setInterval(() => setSecs((performance.now() - t0) / 1000), 250);
      (r as { timer?: number }).timer = timer;
    } catch (e) {
      const err = e as Error;
      toast(err.name === 'NotAllowedError' ? 'Allow microphone access to record your guitar.' : err.message);
      await teardown();
      setPhase('setup');
    }
  };

  const stopRecording = async () => {
    const r = rt.current;
    if (!r) return;
    window.clearInterval((r as { timer?: number }).timer);
    const sig = joinChunks(r.chunks.map((c) => c.di));
    r.chunks = [];
    if (sig.length < r.ctx.sampleRate * 20) { toast('Record at least 20 seconds of playing (a few minutes of varied playing trains best).'); await teardown(); setPhase('setup'); return; }
    di.current = sig;
    setPhase('waiting');
    if (waitSecs > 0) {
      for (let s = waitSecs; s > 0; s--) { setCountdown(s); await new Promise((res) => setTimeout(res, 1000)); if (cancelled.current) return; }
      await reamp();
    }
  };

  const reamp = async () => {
    const r = rt.current;
    const dry = di.current;
    if (!r || !dry) return;
    setPhase('reamping');
    const sr = r.ctx.sampleRate;
    // three short clicks, then the DI exactly as recorded
    const lead = Math.round(MARKERS * MARKER_SPACING * sr);
    const played = new Float32Array(lead + dry.length);
    const pw = Math.round(sr * 0.003);
    for (let k = 0; k < MARKERS; k++) for (let i = 0; i < pw; i++) played[Math.round(k * MARKER_SPACING * sr) + i] = 0.7 * Math.sin((Math.PI * i) / pw);
    played.set(dry, lead);
    const buf = r.ctx.createBuffer(1, played.length, sr);
    buf.copyToChannel(played, 0);
    const node = r.ctx.createBufferSource();
    node.buffer = buf;
    node.connect(r.ctx.destination);
    r.source = node;
    r.chunks = [];
    const when = r.ctx.currentTime + 0.3;
    node.start(when);
    const total = played.length / sr + 1.5;
    const t0 = performance.now();
    await new Promise<void>((res) => {
      const iv = window.setInterval(() => {
        const el = (performance.now() - t0) / 1000;
        setSecs(el);
        if (el > total + 0.3 || cancelled.current) { window.clearInterval(iv); res(); }
      }, 200);
    });
    if (cancelled.current) return;
    // what came back, from just before the playback started
    const kept = r.chunks.filter((c) => c.t + c.di.length / sr >= when - 0.05);
    const returned = joinChunks(kept.map((c) => c.di));
    await teardown();
    setResult({ played, returned, sr });
    setPhase('review');
  };

  const cancel = async () => { cancelled.current = true; await teardown(); di.current = null; setResult(null); setPhase('setup'); };

  const train = async () => {
    if (!result) return;
    setPhase('uploading');
    try {
      const fd = new FormData();
      const device = name.trim() || 'New capture';
      fd.append('name', setting.trim() ? `${device} – ${setting.trim()}` : device);
      fd.append('device', device);
      if (setting.trim()) fd.append('setting', setting.trim());
      fd.append('role', role);
      fd.append('epochs', String(epochs));
      fd.append('markers', String(MARKERS));
      fd.append('markerSpacing', String(Math.round(MARKER_SPACING * result.sr)));
      fd.append('played', new Blob([encodeWav([result.played], result.sr, true) as BlobPart], { type: 'audio/wav' }), 'played.wav');
      fd.append('returned', new Blob([encodeWav([result.returned], result.sr, true) as BlobPart], { type: 'audio/wav' }), 'returned.wav');
      await api.trainPair(fd);
      toast('Training started. The model lands in your library when it’s done.');
      setResult(null);
      di.current = null;
      setPhase('setup');
      onStarted();
    } catch (e) {
      toast((e as Error).message);
      setPhase('review');
    }
  };

  const busy = phase !== 'setup';
  const retPeak = result ? peakOf(result.returned) : 0;
  const diPeak = di.current ? peakOf(di.current) : 0;
  return (
    <section className="card setcard autocap">
      <h3>Automated capture</h3>
      <ol className="capsteps">
        <li className={phase === 'setup' || phase === 'recording' ? 'on' : 'done'}>Plug your guitar into the input and press Record. Play for a few minutes: chords, single notes, quiet and loud, palm mutes, the whole neck.</li>
        <li className={phase === 'waiting' ? 'on' : phase === 'reamping' || phase === 'review' || phase === 'uploading' ? 'done' : ''}>Press Stop, then move the cable: connect the output to your amp or pedal (through a reamp box), and its output back to the same input.</li>
        <li className={phase === 'reamping' ? 'on' : phase === 'review' || phase === 'uploading' ? 'done' : ''}>Fretforge plays your recording through the gear and records what comes back.</li>
        <li className={phase === 'review' || phase === 'uploading' ? 'on' : ''}>It lines the two up and trains a model in the AI worker. Give the device a name and the setting you captured: captures of one device become one block with a setting switch.</li>
      </ol>

      <div className="iogrid">
        <label className="field"><span>Input</span>
          <select value={inputId} onChange={(e) => setInputId(e.target.value)} disabled={busy} id="cap-in">
            <option value="">Default input</option>
            {inputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Input'}</option>)}
          </select>
        </label>
        <label className="field"><span>Channel</span>
          <select value={channel} onChange={(e) => setChannel(Number(e.target.value))} disabled={busy} id="cap-ch"><option value={0}>1 (left)</option><option value={1}>2 (right)</option></select>
        </label>
        <label className="field"><span>Output to the gear</span>
          <select value={outputId} onChange={(e) => setOutputId(e.target.value)} disabled={busy} id="cap-out">
            <option value="">Default output</option>
            {outputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Output'}</option>)}
          </select>
        </label>
        <label className="field"><span>Wait before playing it back</span>
          <select value={waitSecs} onChange={(e) => setWaitSecs(Number(e.target.value))} disabled={busy} id="cap-wait">
            {[2, 3, 5, 10, 20, 30].map((s) => <option key={s} value={s}>{s} seconds</option>)}
            <option value={0}>Until I press Continue</option>
          </select>
        </label>
      </div>

      {phase === 'setup' && (
        <div className="row">
          <button className="btn primary" onClick={() => void startRecording()}><span className="recdot" /> Record the guitar</button>
          <span className="faint" style={{ fontSize: 13 }}>Use the same input for both steps; turn off direct monitoring that would feed the output back.</span>
        </div>
      )}
      {phase === 'recording' && (
        <div className="row">
          <button className="btn danger" onClick={() => void stopRecording()}><span className="recdot" /> Stop · {formatTime(secs * 1000)}</button>
          <span className="capmeter" aria-label={`Input level ${Math.round(dbfs(level))} dBFS`}><i style={{ width: `${Math.max(0, Math.min(100, (dbfs(level) + 60) / 60 * 100))}%` }} className={level > 0.98 ? 'clip' : ''} /></span>
          <button className="btn ghost" onClick={() => void cancel()}>Cancel</button>
        </div>
      )}
      {phase === 'waiting' && (
        <div className="capwait" role="status">
          <b>Connect the output to your gear and the gear back to the input.</b>
          {waitSecs > 0 ? <span>Playing it back in {countdown}…</span> : <button className="btn primary" onClick={() => void reamp()}>Continue</button>}
          <button className="btn ghost sm" onClick={() => void cancel()}>Cancel</button>
        </div>
      )}
      {phase === 'reamping' && (
        <div className="row" role="status">
          <span className="spinner" /> <span>Playing through the gear and recording it… {formatTime(secs * 1000)} / {formatTime(((di.current?.length ?? 0) / (rt.current?.ctx.sampleRate ?? 48000)) * 1000 + MARKERS * MARKER_SPACING * 1000)}</span>
          <span className="capmeter"><i style={{ width: `${Math.max(0, Math.min(100, (dbfs(level) + 60) / 60 * 100))}%` }} className={level > 0.98 ? 'clip' : ''} /></span>
          <button className="btn ghost sm" onClick={() => void cancel()}>Cancel</button>
        </div>
      )}
      {(phase === 'review' || phase === 'uploading') && result && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="row" style={{ gap: 12 }}>
            <span className="badge">{formatTime((result.played.length / result.sr) * 1000)} of playing</span>
            <span className={'badge ' + (diPeak > 0.98 ? 'bad' : '')}>DI peak {dbfs(diPeak).toFixed(1)} dBFS</span>
            <span className={'badge ' + (retPeak < 0.003 ? 'bad' : retPeak > 0.98 ? 'bad' : 'good')}>Gear peak {dbfs(retPeak).toFixed(1)} dBFS</span>
          </div>
          {retPeak < 0.003 && <div className="error">Almost nothing came back on the input. Check the cables, then record again.</div>}
          {retPeak > 0.98 && <p className="faint" style={{ margin: 0, fontSize: 13 }}>The gear’s return clipped; turn its output down a little for a cleaner capture.</p>}
          <div className="row">
            <input type="text" id="cap-name" placeholder="Device, e.g. My Klon" value={name} onChange={(e) => setName(e.target.value)} aria-label="Device name" list="ff-cap-devices" />
            <datalist id="ff-cap-devices">{deviceNames.map((d) => <option key={d} value={d} />)}</datalist>
            <input type="text" id="cap-setting" placeholder="Setting, e.g. Gain 2 o’clock" value={setting} onChange={(e) => setSetting(e.target.value)} aria-label="Setting" />
            <select value={role} onChange={(e) => setRole(e.target.value as NamRole)} aria-label="It’s a">{NAM_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
            <label className="row" style={{ gap: 6 }}>Epochs <input type="number" min={10} max={1000} value={epochs} onChange={(e) => setEpochs(Number(e.target.value) || 100)} style={{ width: 80 }} /></label>
          </div>
          <div className="row">
            <button className="btn primary" disabled={phase === 'uploading' || !aiReady || retPeak < 0.003} title={aiReady ? '' : aiReason} onClick={() => void train()}>{phase === 'uploading' ? <span className="spinner" /> : Icon.cpu({ size: 15 })} Train the model</button>
            <button className="btn ghost" onClick={() => void cancel()}>Start over</button>
          </div>
        </div>
      )}
    </section>
  );
}

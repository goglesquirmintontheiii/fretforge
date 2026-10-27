import { useEffect, useMemo, useRef, useState } from 'react';
import { compileNam, decodeWav, defaultAmp, namNormalizeGain, prepareIr, type AmpSettings, type RigFile } from '@fretforge/shared';
import { api } from '../api';
import { useApp } from '../lib/app';
import { askConfirm } from '../lib/dialog';
import { AmpEditor, AmpPresets, describeRigFile, refreshRigFiles, useRigFiles, useUpload } from '../components/AmpEditor';
import { Icon } from '../components/icons';
import { ENGINE_RATE, audioContext, engineWasm, processAmp, rigFileBytes, rigFileText, rigLite } from '../audio/engine';
import { RigParam } from '../audio/forgeDsp';
import { diRiff } from './diRiff';
import { JobRow, useJobs } from '../player/AudioPanel';

const AMP_KEY = 'ff-live-amp';

function loadAmp(): AmpSettings {
  try { return { ...defaultAmp, ...JSON.parse(localStorage.getItem(AMP_KEY) || '{}') }; } catch { return { ...defaultAmp }; }
}

function paramsOf(a: AmpSettings): [RigParam, number][] {
  return [
    [RigParam.InputDb, a.inputDb], [RigParam.OutputDb, a.outputDb], [RigParam.GateOn, a.gate ? 1 : 0], [RigParam.GateDb, a.gateDb],
    [RigParam.BassDb, a.bassDb], [RigParam.MidDb, a.midDb], [RigParam.TrebleDb, a.trebleDb], [RigParam.LowCutHz, a.lowCutHz],
    [RigParam.HighCutHz, a.highCutHz], [RigParam.IrMix, a.irMix], [RigParam.NamOn, a.enabled ? 1 : 0], [RigParam.IrOn, a.enabled ? 1 : 0],
  ];
}

/** Loads the model and IR for an amp: what both live engines need. */
async function loadRigAssets(a: AmpSettings) {
  const nam = a.namId ? compileNam(await rigFileText(a.namId), { lite: rigLite }) : null;
  const ir = a.irId ? prepareIr(decodeWav(new Uint8Array(await rigFileBytes(a.irId))), ENGINE_RATE) : null;
  return { nam, ir };
}

export function RigView() {
  const { user } = useApp();
  const canEdit = user?.role !== 'viewer';
  const [amp, setAmp] = useState<AmpSettings>(loadAmp);
  useEffect(() => { try { localStorage.setItem(AMP_KEY, JSON.stringify(amp)); } catch { /* ignore */ } }, [amp]);
  const native = window.fretforgeDesktop?.engine;
  return (
    <div className="page">
      <div className="section-h"><h2>Rig</h2><span className="muted">Play your guitar through NAM captures and cabinet IRs</span></div>
      <div className="riggrid">
        <section className="card setcard">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3>Amp</h3>
            <AmpPresets value={amp} onLoad={setAmp} />
          </div>
          <AmpEditor value={amp} onChange={setAmp} />
          <Preview amp={amp} />
        </section>
        <div style={{ display: 'grid', gap: 18, alignContent: 'start' }}>
          {native ? <NativeRig amp={amp} /> : null}
          <BrowserRig amp={amp} secondary={!!native} />
        </div>
      </div>
      <RigLibrary canEdit={canEdit} />
      {canEdit && <TrainCapture />}
    </div>
  );
}

// ------------------------------------------------------------------ preview without a guitar
function Preview({ amp }: { amp: AmpSettings }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState<number | null>(null);
  const src = useRef<AudioBufferSourceNode | null>(null);
  const play = async () => {
    src.current?.stop();
    setBusy(0);
    try {
      const ctx = await audioContext();
      await ctx.resume();
      const dry = diRiff(ENGINE_RATE);
      const wet = amp.enabled ? await processAmp(dry, amp, ENGINE_RATE, (f) => setBusy(f)) : dry;
      let peak = 0;
      for (const v of wet) peak = Math.max(peak, Math.abs(v));
      const buf = ctx.createBuffer(1, wet.length, ENGINE_RATE);
      buf.getChannelData(0).set(peak > 0.9 ? wet.map((v) => (v * 0.9) / peak) : wet);
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(ctx.destination);
      s.start();
      src.current = s;
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="row">
      <button className="btn" onClick={play} disabled={busy !== null}>{busy !== null ? <><span className="spinner" /> {Math.round(busy * 100)}%</> : <>{Icon.play({ size: 14 })} Preview with a riff</>}</button>
      <span className="faint" style={{ fontSize: 12 }}>Hear the settings on a built-in guitar riff, no instrument needed.</span>
    </div>
  );
}

// ------------------------------------------------------------------ browser engine (WASM in an AudioWorklet)
function Meter({ v, label }: { v: number; label: string }) {
  const db = v > 0 ? 20 * Math.log10(v) : -90;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  return (
    <div className="meter" title={`${label}: ${db > -89 ? db.toFixed(1) + ' dBFS' : 'silent'}`}>
      <span>{label}</span>
      <div><i style={{ width: `${pct}%` }} className={db > -1 ? 'clip' : db > -9 ? 'hot' : ''} /></div>
    </div>
  );
}

function BrowserRig({ amp, secondary }: { amp: AmpSettings; secondary: boolean }) {
  const { toast } = useApp();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(() => { try { return localStorage.getItem('ff-rig-in') ?? ''; } catch { return ''; } });
  const [on, setOn] = useState(false);
  const [meter, setMeter] = useState({ input: 0, output: 0, load: 0 });
  const [latency, setLatency] = useState<number | null>(null);
  const node = useRef<AudioWorkletNode | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const srcNode = useRef<MediaStreamAudioSourceNode | null>(null);
  const loadedKey = useRef('');

  const refreshDevices = () => navigator.mediaDevices?.enumerateDevices().then((d) => setDevices(d.filter((x) => x.kind === 'audioinput'))).catch(() => {});
  useEffect(() => { refreshDevices(); }, []);

  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    srcNode.current?.disconnect();
    node.current?.disconnect();
    node.current = null;
    stream.current = null;
    loadedKey.current = '';
    setOn(false);
  };
  useEffect(() => stop, []);

  const start = async () => {
    try {
      const ctx = await audioContext();
      await ctx.resume();
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      refreshDevices();
      const n = new AudioWorkletNode(ctx, 'ff-rig', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      await new Promise<void>((resolve) => {
        n.port.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'ready') resolve();
          // peak hold with a short fall-off, like a hardware meter
          else if (m.type === 'meter') setMeter((p) => ({ input: Math.max(m.input, p.input * 0.85), output: Math.max(m.output, p.output * 0.85), load: m.load }));
          else if (m.type === 'error') toast(m.message);
        };
        engineWasm().then((w) => n.port.postMessage({ type: 'init', wasm: w.slice(0) }));
      });
      const src = ctx.createMediaStreamSource(s);
      src.connect(n);
      n.connect(ctx.destination);
      stream.current = s;
      srcNode.current = src;
      node.current = n;
      const trackLatency = (s.getAudioTracks()[0]?.getSettings() as { latency?: number }).latency ?? 0;
      setLatency(Math.round(((ctx.baseLatency || 0) + ((ctx as AudioContext & { outputLatency?: number }).outputLatency || 0) + trackLatency + 128 / ctx.sampleRate) * 1000));
      setOn(true);
    } catch (e) {
      toast((e as Error).name === 'NotAllowedError' ? 'Allow microphone access to play through the rig.' : (e as Error).message);
      stop();
    }
  };

  // keep the worklet's chain in sync with the editor
  useEffect(() => {
    const n = node.current;
    if (!on || !n) return;
    for (const [id, v] of paramsOf(amp)) n.port.postMessage({ type: 'param', id, value: v });
    const key = `${amp.namId}|${amp.irId}|${rigLite}`;
    if (key === loadedKey.current) return;
    loadedKey.current = key;
    loadRigAssets(amp).then(({ nam, ir }) => {
      if (nam) n.port.postMessage({ type: 'nam', code: nam.code, weights: nam.weights, gain: namNormalizeGain(nam.info) });
      else n.port.postMessage({ type: 'nam', code: null });
      n.port.postMessage({ type: 'ir', data: ir });
    }).catch((e) => toast(e.message));
  }, [on, amp]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card setcard">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>{secondary ? 'Browser input (fallback)' : 'Play live'}</h3>
        <button className={'btn ' + (on ? 'on' : 'primary')} onClick={on ? stop : start}>{Icon.power({ size: 15 })} {on ? 'Stop' : 'Start'}</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Runs the amp in the browser. Expect roughly 20–40 ms of delay depending on your system; the desktop app’s JACK engine gets much lower.</p>
      <label className="field"><span>Input</span>
        <select id="rig-input" value={deviceId} onChange={(e) => { setDeviceId(e.target.value); try { localStorage.setItem('ff-rig-in', e.target.value); } catch { /* ignore */ } if (on) { stop(); } }}>
          <option value="">Default input</option>
          {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Audio input'}</option>)}
        </select>
      </label>
      {on && (
        <>
          <Meter v={meter.input} label="In" />
          <Meter v={meter.output} label="Out" />
          <div className="row" style={{ gap: 14, fontSize: 13 }}>
            <span className="muted">Estimated latency <b className="mono">{latency ?? '—'} ms</b></span>
            <span className="muted">DSP load <b className="mono">{Math.round(meter.load * 100)}%</b></span>
          </div>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ desktop engine (native, JACK / PipeWire)
function NativeRig({ amp }: { amp: AmpSettings }) {
  const eng = window.fretforgeDesktop!.engine!;
  const { toast } = useApp();
  const [st, setSt] = useState<Awaited<ReturnType<typeof eng.status>> | null>(null);
  const [meter, setMeter] = useState({ input: 0, output: 0, load: 0, xruns: 0 });
  const [test, setTest] = useState<string | null>(null);
  const loadedKey = useRef('');

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const s = await eng.status().catch(() => null);
      if (!alive) return;
      setSt(s);
      if (s?.running) {
        const m = await eng.meters().catch(() => ({ input: 0, output: 0, load: 0, xruns: 0 }));
        setMeter((p) => ({ ...m, input: Math.max(m.input, p.input * 0.8), output: Math.max(m.output, p.output * 0.8) }));
      }
    };
    poll();
    const t = setInterval(poll, 150);
    return () => { alive = false; clearInterval(t); };
  }, [eng]);

  useEffect(() => {
    if (!st?.running) { loadedKey.current = ''; return; }
    for (const [id, v] of paramsOf(amp)) eng.setParam(id, v);
    const key = `${amp.namId}|${amp.irId}`;
    if (key === loadedKey.current) return;
    loadedKey.current = key;
    loadRigAssets(amp).then(async ({ nam, ir }) => {
      if (nam) await eng.loadNam(nam.code, nam.weights, namNormalizeGain(nam.info));
      else await eng.clearNam();
      await eng.loadIr(ir);
    }).catch((e) => toast(e.message));
  }, [st?.running, amp]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = !!st?.running;
  return (
    <section className="card setcard">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>Low-latency engine</h3>
        <button className={'btn ' + (running ? 'on' : 'primary')} disabled={!st?.available} onClick={async () => {
          try { if (running) await eng.stop(); else await eng.start({}); loadedKey.current = ''; } catch (e) { toast((e as Error).message); }
        }}>{Icon.power({ size: 15 })} {running ? 'Stop' : 'Start'}</button>
      </div>
      {!st ? <span className="spinner" /> : !st.available ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{st.reason || 'The native engine is not available.'}</p>
      ) : (
        <>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {st.backend ?? 'JACK'} · {st.sampleRate ? `${st.sampleRate / 1000} kHz` : ''}{st.bufferSize ? ` · ${st.bufferSize} samples` : ''}
            {st.latencyMs ? ` · ${st.latencyMs.toFixed(1)} ms buffer latency` : ''}. Set the buffer with <span className="mono">PIPEWIRE_LATENCY</span> or in your JACK settings.
          </p>
          {running && (
            <>
              <Meter v={meter.input} label="In" />
              <Meter v={meter.output} label="Out" />
              <div className="row" style={{ gap: 14, fontSize: 13 }}>
                <span className="muted">DSP load <b className="mono">{Math.round(meter.load * 100)}%</b></span>
                <span className="muted">Dropouts <b className="mono">{meter.xruns}</b></span>
              </div>
              <div className="row">
                <button className="btn sm" onClick={async () => { setTest('Measuring…'); const r = await eng.measureLatency().catch((e) => ({ roundTripMs: null, message: (e as Error).message })); setTest(r.roundTripMs ? `Round trip: ${r.roundTripMs.toFixed(1)} ms` : r.message); }}>Measure round-trip latency</button>
                {test && <span className="mono" style={{ fontSize: 13 }}>{test}</span>}
              </div>
              <span className="faint" style={{ fontSize: 12 }}>For the measurement, connect an output of your interface to its input with a cable (turn speakers down first).</span>
            </>
          )}
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ library of .nam and .wav files
function RigLibrary({ canEdit }: { canEdit: boolean }) {
  const files = useRigFiles();
  const { toast } = useApp();
  const { pick, busy } = useUpload();
  const [kind, setKind] = useState<'all' | 'nam' | 'ir'>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const list = useMemo(() => (files ?? []).filter((f) => (kind === 'all' || f.kind === kind) && (!q || `${f.name} ${f.tags.join(' ')} ${f.gearMake ?? ''} ${f.gearModel ?? ''} ${f.author ?? ''}`.toLowerCase().includes(q.toLowerCase()))), [files, kind, q]);
  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <div className="section-h">
        <h2>Models and IRs</h2>
        <span className="muted">{files?.length ?? 0} file{files?.length === 1 ? '' : 's'}</span>
        <span className="grow" />
        {canEdit && <button className="btn sm" onClick={() => pick()} disabled={busy}>{busy ? <span className="spinner" /> : Icon.upload({ size: 15 })} Add .nam or .wav files</button>}
      </div>
      <div className="row">
        <div className="chips" role="group" aria-label="Type">
          {(['all', 'nam', 'ir'] as const).map((k) => <button key={k} className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{k === 'all' ? 'All' : k === 'nam' ? 'NAM models' : 'Cabinet IRs'}</button>)}
        </div>
        <input type="search" id="rig-filter" className="grow" placeholder="Filter by name, tag, gear or author" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter models" />
      </div>
      {files === null ? <div className="empty"><span className="spinner" /></div> : list.length === 0 ? (
        <div className="empty"><b>{files.length ? 'Nothing matches' : 'No models yet'}</b>{files.length ? '' : 'Add NAM captures (.nam) of amps, pedals or full rigs and cabinet impulse responses (.wav). ToneHunt and the NAM community share thousands.'}</div>
      ) : (
        <div className="card songlist">
          {list.map((f) => (
            <div key={f.id} className="rigfile">
              <span className={'kind ' + f.kind}>{f.kind === 'nam' ? 'NAM' : 'IR'}</span>
              <div style={{ minWidth: 0 }}>
                {editing === f.id ? <RigFileForm f={f} onDone={() => setEditing(null)} /> : (
                  <>
                    <div className="t">{f.name}</div>
                    <div className="a">{describeRigFile(f)}{f.author ? ` · by ${f.author}` : ''}</div>
                    {f.tags.length > 0 && <div className="chips" style={{ marginTop: 4 }}>{f.tags.map((t) => <span key={t} className="badge">{t}</span>)}</div>}
                  </>
                )}
              </div>
              {canEdit && editing !== f.id && (
                <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                  <button className="iconbtn" aria-label={`Edit ${f.name}`} onClick={() => setEditing(f.id)}>{Icon.edit({ size: 15 })}</button>
                  <button className="iconbtn" aria-label={`Delete ${f.name}`} onClick={async () => {
                    if (!(await askConfirm(`Delete “${f.name}”?`, { body: 'Songs and presets that use it play without it.', ok: 'Delete', danger: true }))) return;
                    await api.deleteRigFile(f.id).catch((e) => toast(e.message));
                    refreshRigFiles();
                  }}>{Icon.trash({ size: 15 })}</button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RigFileForm({ f, onDone }: { f: RigFile; onDone: () => void }) {
  const [name, setName] = useState(f.name);
  const [tags, setTags] = useState(f.tags.join(', '));
  const [gearType, setGearType] = useState(f.gearType ?? '');
  const [author, setAuthor] = useState(f.author ?? '');
  return (
    <form className="row" style={{ gap: 6 }} onSubmit={async (e) => {
      e.preventDefault();
      await api.patchRigFile(f.id, { name, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), gearType, author });
      await refreshRigFiles();
      onDone();
    }}>
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
      <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" placeholder="tags, comma separated" />
      {f.kind === 'nam' && (
        <select value={gearType} onChange={(e) => setGearType(e.target.value)} aria-label="Gear type">
          <option value="">Type…</option><option value="amp">Amp</option><option value="pedal">Pedal</option><option value="pedal_amp">Pedal + amp</option><option value="amp_cab">Amp + cab</option><option value="amp_pedal_cab">Full rig</option><option value="preamp">Preamp</option><option value="studio">Studio gear</option>
        </select>
      )}
      <input type="text" value={author} onChange={(e) => setAuthor(e.target.value)} aria-label="Author" placeholder="Author" />
      <button className="btn sm primary">Save</button>
      <button type="button" className="btn sm" onClick={onDone}>Cancel</button>
    </form>
  );
}

// ------------------------------------------------------------------ training your own captures
function TrainCapture() {
  const { toast } = useApp();
  const { jobs, ai, refresh } = useJobs();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [epochs, setEpochs] = useState(100);
  const training = jobs.filter((j) => j.kind === 'train-nam').slice(0, 3);
  return (
    <section className="card setcard">
      <h3>Train a capture</h3>
      <p className="muted" style={{ margin: 0 }}>
        Reamp NAM’s standard test signal (input.wav from the NAM project) through your amp or pedal, record the result at the same sample rate and length, and upload the recording.
        Training runs in the AI worker and the finished model lands in this library. Put the test signal next to the worker script (<span className="mono">ai/input.wav</span>).
      </p>
      <div className="row">
        <input type="file" accept=".wav,audio/wav" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Recorded output" />
        <input type="text" placeholder="Name, e.g. My amp – crunch" value={name} onChange={(e) => setName(e.target.value)} aria-label="Capture name" />
        <label className="row" style={{ gap: 6 }}>Epochs <input type="number" min={10} max={1000} value={epochs} onChange={(e) => setEpochs(Number(e.target.value) || 100)} style={{ width: 80 }} /></label>
        <button className="btn" disabled={!file || !name.trim() || !ai?.available} title={ai?.available ? '' : ai?.reason} onClick={async () => {
          try { await api.trainNam(file!, name.trim(), epochs); refresh(); toast('Training started'); } catch (e) { toast((e as Error).message); }
        }}>Train</button>
      </div>
      {training.map((j) => <JobRow key={j.id} j={j} onCancel={() => api.cancelJob(j.id).then(refresh)} />)}
    </section>
  );
}

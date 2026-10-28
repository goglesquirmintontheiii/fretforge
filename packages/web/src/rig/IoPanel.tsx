// Audio in/out for the live rig: the browser's devices, or the desktop engine's JACK ports
// (which also show up in Helvum, qpwgraph or any PipeWire patchbay), plus the global output
// EQ, MIDI inputs and the latency test.
import { useEffect, useState } from 'react';
import { BLOCK_BY_TYPE } from '@fretforge/shared';
import { Icon } from '../components/icons';
import { useApp } from '../lib/app';
import { ParamKnob } from './BlockPanel';
import { loadIo, saveIo, useLive, type IoSettings } from './LiveRig';

export function IoPanel({ onClose }: { onClose(): void }) {
  const live = useLive();
  const [io, setIoState] = useState<IoSettings>(loadIo);
  const setIo = (next: IoSettings) => { setIoState(next); saveIo(next); };
  const native = !!window.fretforgeDesktop?.engine && live.nativeAvailable;
  const [tab, setTab] = useState<'native' | 'browser'>(live.kind ?? (native ? 'native' : 'browser'));
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="modal wide iopanel" role="dialog" aria-modal="true" aria-label="Audio and MIDI">
        <header><h2 style={{ fontSize: 18 }}>Audio and MIDI</h2><button className="iconbtn" onClick={onClose} aria-label="Close">{Icon.close({ size: 16 })}</button></header>
        {native && (
          <div className="chips" role="tablist">
            <button className="chip" role="tab" aria-selected={tab === 'native'} aria-pressed={tab === 'native'} onClick={() => setTab('native')}>Low-latency engine (JACK)</button>
            <button className="chip" role="tab" aria-selected={tab === 'browser'} aria-pressed={tab === 'browser'} onClick={() => setTab('browser')}>Browser audio</button>
          </div>
        )}
        {tab === 'native' && native ? <NativeIo io={io} setIo={setIo} /> : <BrowserIoForm io={io} setIo={setIo} />}
        <GlobalEq io={io} setIo={setIo} />
        <section className="iosec">
          <h3>MIDI</h3>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {live.midiInputs.length ? `Listening to ${live.midiInputs.join(', ')}.` : 'No MIDI controllers found yet (they appear once the live rig is on).'}
            {native ? ' The desktop engine also has a JACK MIDI input (Fretforge:midi_in) for foot controllers you route in a patchbay.' : ''}
            {' '}Use “MIDI” next to any knob, “Learn footswitch” on a block, or set a program number on a rig to switch rigs.
          </p>
        </section>
      </div>
    </div>
  );
}

function BrowserIoForm({ io, setIo }: { io: IoSettings; setIo(v: IoSettings): void }) {
  const live = useLive();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const refresh = () => navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => {});
  useEffect(() => { refresh(); navigator.mediaDevices?.addEventListener?.('devicechange', refresh); return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh); }, []);
  const ins = devices.filter((d) => d.kind === 'audioinput'), outs = devices.filter((d) => d.kind === 'audiooutput');
  const canSink = 'setSinkId' in AudioContext.prototype;
  const b = io.browser;
  const set = (p: Partial<IoSettings['browser']>) => setIo({ ...io, browser: { ...b, ...p } });
  const restart = live.kind === 'browser' ? async () => { await live.stop(); await live.start('browser'); } : null;
  return (
    <section className="iosec">
      <h3>Browser audio</h3>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Works anywhere; expect roughly 20–40 ms of delay. Device names appear after you allow microphone access once.</p>
      <div className="iogrid">
        <label className="field"><span>Input</span>
          <select value={b.inputId ?? ''} onChange={(e) => set({ inputId: e.target.value || undefined })} id="io-input">
            <option value="">System default</option>
            {ins.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Audio input'}</option>)}
          </select>
        </label>
        <label className="field"><span>Input channel</span>
          <select value={b.channel ?? 0} onChange={(e) => set({ channel: Number(e.target.value) })}>
            <option value={0}>1 (left)</option><option value={1}>2 (right)</option>
          </select>
        </label>
        <label className="field"><span>Output</span>
          <select value={b.outputId ?? ''} onChange={(e) => set({ outputId: e.target.value || undefined })} disabled={!canSink} id="io-output">
            <option value="">System default</option>
            {outs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Audio output'}</option>)}
          </select>
        </label>
      </div>
      {!canSink && <span className="faint" style={{ fontSize: 12 }}>This browser can’t choose the output device; it uses the system default.</span>}
      {restart && <button className="btn sm" onClick={restart}>Apply (restarts the live rig)</button>}
    </section>
  );
}

function NativeIo({ io, setIo }: { io: IoSettings; setIo(v: IoSettings): void }) {
  const live = useLive();
  const { toast } = useApp();
  const eng = window.fretforgeDesktop!.engine!;
  const [ports, setPorts] = useState<NativePorts | null>(null);
  const [conns, setConns] = useState<Record<string, string[] | undefined>>({});
  const [test, setTest] = useState<string | null>(null);
  const n = io.native;
  const running = live.kind === 'native';
  const refresh = async () => {
    if (!running) return;
    setPorts(await eng.ports().catch(() => null));
    setConns(await eng.connections().catch(() => ({})));
  };
  useEffect(() => { void refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<IoSettings['native']>) => setIo({ ...io, native: { ...n, ...p } });
  const own = (p: string) => p.startsWith(`${live.status?.client ?? 'Fretforge'}:`);
  const sources = (ports?.sources ?? []).filter((p) => !own(p));
  const sinks = (ports?.sinks ?? []).filter((p) => !own(p));
  const toggle = async (ours: 'in' | 'out_L' | 'out_R', other: string, on: boolean) => {
    const ok = await eng.connect(ours, other, on).catch(() => false);
    if (!ok) toast('JACK didn’t make that connection.');
    await refresh();
    // remember the choice for the next start
    if (ours === 'in') set({ inputs: on ? [...new Set([...(n.inputs ?? []), other])] : (n.inputs ?? []).filter((x) => x !== other) });
    else {
      const outs = [...(n.outputs ?? [])];
      outs[ours === 'out_L' ? 0 : 1] = on ? other : '';
      set({ outputs: outs });
    }
  };
  return (
    <section className="iosec">
      <h3>Low-latency engine</h3>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Fretforge shows up as a JACK/PipeWire client with ports <span className="mono">in</span>, <span className="mono">out_L</span>, <span className="mono">out_R</span> and <span className="mono">midi_in</span>.
        Route them here, or in Helvum, qpwgraph or any patchbay: other programs can feed the rig and take its output.
      </p>
      <div className="row">
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={n.connect !== false} onChange={(e) => set({ connect: e.target.checked })} /> Connect automatically when the engine starts</label>
        <label className="row" style={{ gap: 6 }}>Buffer
          <select value={n.latency ?? 0} onChange={(e) => set({ latency: Number(e.target.value) || undefined })} title="PipeWire honours this when the engine starts">
            <option value={0}>System setting</option>{[32, 64, 128, 256, 512].map((v) => <option key={v} value={v}>{v} samples</option>)}
          </select>
        </label>
      </div>
      {!running ? <p className="faint" style={{ margin: 0, fontSize: 13 }}>Start the live rig with the low-latency engine to see and change its connections.</p> : (
        <div className="ports">
          <PortList title="Input (guitar)" ports={sources} connected={conns.in ?? []} onToggle={(p, on) => toggle('in', p, on)} physical={ports?.physicalSources ?? []} />
          <PortList title="Output left" ports={sinks} connected={conns.out_L ?? []} onToggle={(p, on) => toggle('out_L', p, on)} physical={ports?.physicalSinks ?? []} />
          <PortList title="Output right" ports={sinks} connected={conns.out_R ?? []} onToggle={(p, on) => toggle('out_R', p, on)} physical={ports?.physicalSinks ?? []} />
        </div>
      )}
      {running && (
        <div className="row">
          <button className="btn sm" onClick={async () => { setTest('Measuring…'); const r = await eng.measureLatency().catch((e) => ({ roundTripMs: null, message: (e as Error).message })); setTest(r.roundTripMs ? `Round trip: ${r.roundTripMs.toFixed(1)} ms` : r.message); }}>Measure round-trip latency</button>
          {test && <span className="mono" style={{ fontSize: 13 }}>{test}</span>}
          <span className="faint" style={{ fontSize: 12 }}>Loop an output of your interface back to an input with a cable first (speakers down).</span>
        </div>
      )}
    </section>
  );
}

function PortList({ title, ports, connected, physical, onToggle }: { title: string; ports: string[]; connected: string[]; physical: string[]; onToggle(p: string, on: boolean): void }) {
  const sorted = [...ports].sort((a, b) => Number(physical.includes(b)) - Number(physical.includes(a)) || a.localeCompare(b));
  return (
    <div className="portlist">
      <b>{title}</b>
      <div role="group" aria-label={title}>
        {sorted.length === 0 && <span className="faint">No ports</span>}
        {sorted.map((p) => (
          <label key={p} className="port">
            <input type="checkbox" checked={connected.includes(p)} onChange={(e) => onToggle(p, e.target.checked)} />
            <span className="mono">{p}</span>{physical.includes(p) && <span className="badge">hardware</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

function GlobalEq({ io, setIo }: { io: IoSettings; setIo(v: IoSettings): void }) {
  const live = useLive();
  const def = BLOCK_BY_TYPE.get(31)!;
  const eq = io.eq ?? Object.fromEntries(def.params.map((p) => [p.id, p.def]));
  const change = (id: string, v: number) => {
    const next = { ...eq, [id]: v };
    setIo({ ...io, eq: next });
    const i = def.params.findIndex((p) => p.id === id);
    live.io(10 + i, v);
  };
  return (
    <section className="iosec">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>Global output EQ</h3>
        <button className="btn sm ghost" onClick={() => setIo({ ...io, eq: null })}>Reset</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Applies after every rig, for your room, monitors or headphones. </p>
      <div className="faceplate"><div className="knobs">{def.params.map((p) => <ParamKnob key={p.id} p={p} value={eq[p.id] ?? p.def} onChange={(v) => change(p.id, v)} size={46} />)}</div></div>
    </section>
  );
}

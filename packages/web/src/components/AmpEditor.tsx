import { useEffect, useRef, useState } from 'react';
import { defaultAmp, type AmpSettings, type RigFile, type RigPreset } from '@fretforge/shared';
import { api } from '../api';
import { useApp } from '../lib/app';
import { Knob } from './Knob';
import { Icon } from './icons';

// ------------------------------------------------------------------ rig library list (shared by the player and the rig page)
let filesCache: RigFile[] | null = null;
const listeners = new Set<(f: RigFile[]) => void>();

export async function refreshRigFiles(): Promise<RigFile[]> {
  const r = await api.rigFiles();
  filesCache = r.files;
  for (const l of listeners) l(r.files);
  return r.files;
}

export function useRigFiles(): RigFile[] | null {
  const [files, setFiles] = useState<RigFile[] | null>(filesCache);
  useEffect(() => {
    listeners.add(setFiles);
    if (!filesCache) refreshRigFiles().catch(() => setFiles([]));
    return () => { listeners.delete(setFiles); };
  }, []);
  return files;
}

export function describeRigFile(f: RigFile): string {
  if (f.kind === 'nam') {
    const bits = [f.gearMake, f.gearModel].filter(Boolean).join(' ');
    return [bits, String(f.info.runs ?? f.info.architecture ?? ''), f.info.sampleRate ? `${Math.round(Number(f.info.sampleRate) / 1000)} kHz` : ''].filter(Boolean).join(' · ');
  }
  return [`${f.info.lengthMs} ms`, `${Math.round(Number(f.info.sampleRate) / 100) / 10} kHz`, f.info.channels === 2 ? 'stereo' : 'mono'].join(' · ');
}

export function useUpload(kind?: 'nam' | 'ir') {
  const { toast } = useApp();
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = (onAdded?: (f: RigFile[]) => void) => {
    const el = document.createElement('input');
    el.type = 'file';
    el.multiple = true;
    el.accept = kind === 'nam' ? '.nam' : kind === 'ir' ? '.wav' : '.nam,.wav';
    el.onchange = async () => {
      const fs = [...(el.files ?? [])];
      if (!fs.length) return;
      setBusy(true);
      try {
        const r = await api.uploadRigFiles(fs);
        await refreshRigFiles();
        if (r.errors.length) toast(`${r.errors[0].name}: ${r.errors[0].message}`);
        else toast(`Added ${r.added.length} file${r.added.length === 1 ? '' : 's'} to the rig library`);
        onAdded?.(r.added);
      } catch (e) {
        toast((e as Error).message);
      } finally {
        setBusy(false);
      }
    };
    input.current = el;
    el.click();
  };
  return { pick, busy };
}

function FilePicker({ kind, value, onChange, files }: { kind: 'nam' | 'ir'; value: string | null | undefined; onChange: (id: string | null) => void; files: RigFile[] | null }) {
  const { pick, busy } = useUpload(kind);
  const list = (files ?? []).filter((f) => f.kind === kind);
  const cur = list.find((f) => f.id === value);
  const label = kind === 'nam' ? 'Amp / pedal model' : 'Cabinet IR';
  return (
    <div className="field">
      <span>{label}</span>
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <select className="grow" id={`amp-${kind}`} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={label}>
          <option value="">{kind === 'nam' ? 'No model (clean)' : 'No cabinet'}</option>
          {list.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <button className="btn sm" onClick={() => pick((added) => { const a = added.find((x) => x.kind === kind); if (a) onChange(a.id); })} disabled={busy} title={kind === 'nam' ? 'Add .nam files' : 'Add .wav impulse responses'}>
          {busy ? <span className="spinner" /> : Icon.upload({ size: 14 })}<span className="hide-sm">Add</span>
        </button>
      </div>
      {cur && <span className="faint" style={{ fontSize: 12, textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>{describeRigFile(cur)}</span>}
    </div>
  );
}

/** The amp chain controls: model, cabinet, gate and tone. */
export function AmpEditor({ value, onChange, compact }: { value: AmpSettings; onChange: (a: AmpSettings) => void; compact?: boolean }) {
  const files = useRigFiles();
  const set = (p: Partial<AmpSettings>) => onChange({ ...value, ...p });
  const k = compact ? 48 : 56;
  return (
    <div className="amp">
      <div className="amp-files">
        <FilePicker kind="nam" value={value.namId} onChange={(id) => set({ namId: id })} files={files} />
        <FilePicker kind="ir" value={value.irId} onChange={(id) => set({ irId: id })} files={files} />
      </div>
      <div className="faceplate" aria-label="Amp controls">
        <div className="knobs">
          <Knob label="Input" value={value.inputDb} min={-24} max={24} step={0.5} def={0} unit=" dB" onChange={(v) => set({ inputDb: v })} size={k} />
          <Knob label="Bass" value={value.bassDb} min={-12} max={12} step={0.5} def={0} unit=" dB" onChange={(v) => set({ bassDb: v })} size={k} />
          <Knob label="Mid" value={value.midDb} min={-12} max={12} step={0.5} def={0} unit=" dB" onChange={(v) => set({ midDb: v })} size={k} />
          <Knob label="Treble" value={value.trebleDb} min={-12} max={12} step={0.5} def={0} unit=" dB" onChange={(v) => set({ trebleDb: v })} size={k} />
          <Knob label="Output" value={value.outputDb} min={-36} max={24} step={0.5} def={0} unit=" dB" onChange={(v) => set({ outputDb: v })} size={k} />
        </div>
        <div className="knobs">
          <Knob label="Low cut" value={value.lowCutHz} min={0} max={400} step={5} def={0} onChange={(v) => set({ lowCutHz: v })} size={k - 6} format={(v) => (v < 10 ? 'Off' : `${Math.round(v)} Hz`)} />
          <Knob label="High cut" value={value.highCutHz || 20000} min={2000} max={20000} step={100} def={20000} onChange={(v) => set({ highCutHz: v >= 19900 ? 0 : v })} size={k - 6} format={(v) => (v >= 19900 ? 'Off' : `${(v / 1000).toFixed(1)} kHz`)} />
          <Knob label="Cab mix" value={value.irMix * 100} min={0} max={100} step={1} def={100} onChange={(v) => set({ irMix: v / 100 })} size={k - 6} unit="%" disabled={!value.irId} />
          <div className="gatebox">
            <button className={'pedalsw' + (value.gate ? ' on' : '')} aria-pressed={value.gate} onClick={() => set({ gate: !value.gate })} title="Noise gate"><i />Gate</button>
            <Knob label="Threshold" value={value.gateDb} min={-90} max={-20} step={1} def={-60} unit=" dB" onChange={(v) => set({ gateDb: v })} size={k - 10} disabled={!value.gate} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Saved amp settings for reuse across songs. */
export function AmpPresets({ value, onLoad }: { value: AmpSettings; onLoad: (a: AmpSettings) => void }) {
  const { toast } = useApp();
  const [presets, setPresets] = useState<RigPreset[]>([]);
  const [name, setName] = useState('');
  const load = () => api.rigPresets().then((r) => setPresets(r.presets)).catch(() => {});
  useEffect(() => { load(); }, []);
  return (
    <div className="row" style={{ gap: 6 }}>
      <select id="amp-preset" aria-label="Load a preset" value="" onChange={(e) => { const p = presets.find((x) => x.id === e.target.value); if (p) { onLoad({ ...defaultAmp, ...p.amp }); toast(`Loaded “${p.name}”`); } }}>
        <option value="">{presets.length ? 'Load preset…' : 'No presets yet'}</option>
        {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <input type="text" id="amp-preset-name" placeholder="Preset name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 140 }} aria-label="Preset name" />
      <button className="btn sm" disabled={!name.trim()} onClick={async () => { try { await api.saveRigPreset(name.trim(), value); setName(''); load(); toast('Preset saved'); } catch (e) { toast((e as Error).message); } }}>Save</button>
    </div>
  );
}

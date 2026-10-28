// Editing the selected block (knobs, model and IR, on/off, trails, MIDI learn) or split.
import { useMemo } from 'react';
import {
  BLOCK_BY_TYPE, blockState, captureDevices, CATEGORY_LABELS, formatParam, NAM_ROLES, paramToUnit, unitToParam,
  type NamRole, type ParamDef, type RigBlock, type RigDoc, type RigFile, type RigSplit,
} from '@fretforge/shared';
import { Knob } from '../components/Knob';
import { Icon } from '../components/icons';
import { useUpload } from '../components/AmpEditor';
import { go } from '../lib/app';
import { CAT_COLOR, CatGlyph } from './blockArt';
import { roleLabel } from './BlockLibrary';
import { useLive, useLiveMeters } from './LiveRig';

export function ParamKnob({ p, value, onChange, overridden, size }: { p: ParamDef; value: number; onChange(v: number): void; overridden?: boolean; size?: number }) {
  if (p.options) {
    const vals = p.values ?? p.options.map((_, i) => i);
    if (p.options.length <= 4) {
      return (
        <div className="pchoice">
          <span className="kl">{p.label}{overridden && <i className="ovr" title="Changed in this snapshot" />}</span>
          <div className="seg" role="radiogroup" aria-label={p.label}>
            {p.options.map((o, i) => <button key={o} role="radio" aria-checked={value === vals[i]} onClick={() => onChange(vals[i])}>{o}</button>)}
          </div>
        </div>
      );
    }
    return (
      <label className="pchoice">
        <span className="kl">{p.label}{overridden && <i className="ovr" title="Changed in this snapshot" />}</span>
        <select value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={p.label}>
          {p.options.map((o, i) => <option key={o} value={vals[i]}>{o}</option>)}
        </select>
      </label>
    );
  }
  return (
    <div className={'pknob' + (overridden ? ' ovr' : '')}>
      <Knob label={p.label} value={paramToUnit(p, value)} min={0} max={1} step={0.001} def={paramToUnit(p, p.def)} size={size ?? 54}
        zero={p.min < 0 && p.max > 0 && !p.log ? paramToUnit(p, 0) : undefined}
        format={(u) => formatParam(p, unitToParam(p, u))} onChange={(u) => onChange(unitToParam(p, u))} />
    </div>
  );
}

export function BlockPanel({ rig, block, files, allSnapshots, onAllSnapshots, onParam, onToggle, onTrails, onFile, onLabel, onRemove, onDuplicate, onClose }: {
  rig: RigDoc; block: RigBlock; files: RigFile[];
  allSnapshots: boolean; onAllSnapshots(v: boolean): void;
  onParam(id: string, v: number): void; onToggle(): void; onTrails(v: boolean): void;
  onFile(kind: 'nam' | 'ir', slot: number, id: string | null): void; onLabel(l: string): void;
  onRemove(): void; onDuplicate(): void; onClose(): void;
}) {
  const live = useLive();
  const m = useLiveMeters();
  const def = BLOCK_BY_TYPE.get(block.type);
  const snap = rig.snapshots[rig.snapshot];
  const st = blockState(block, snap);
  const over = snap.blocks[block.uid]?.params ?? {};
  if (!def) return <div className="bpanel"><p className="error">This block type isn’t known to this version of Fretforge.</p><button className="btn" onClick={onRemove}>Remove</button></div>;
  const color = CAT_COLOR[def.category];
  const mapping = (param: string) => rig.midi.find((x) => x.target.kind === 'param' && x.target.uid === block.uid && x.target.param === param);
  return (
    <div className="bpanel" style={{ ['--cat' as string]: color }}>
      <header>
        <span className="glyph"><CatGlyph cat={def.category} /></span>
        <div className="grow">
          <input className="blabel" type="text" value={block.label ?? ''} placeholder={def.name} onChange={(e) => onLabel(e.target.value)} aria-label="Block name" />
          <div className="faint" style={{ fontSize: 12 }}>{CATEGORY_LABELS[def.category]} · {def.stereo ? 'stereo' : 'mono'}{def.description ? ` · ${def.description}` : ''}</div>
        </div>
        <button className={'pedalsw' + (st.enabled ? ' on' : '')} onClick={onToggle} aria-pressed={st.enabled} aria-label={st.enabled ? 'On' : 'Off'}><i />{st.enabled ? 'On' : 'Off'}</button>
        <button className="iconbtn" onClick={onClose} aria-label="Close">{Icon.close({ size: 16 })}</button>
      </header>
      {rig.snapshots.length > 1 && (
        <div className="row snapscope">
          <span className="faint">Changes apply to</span>
          <div className="chips" role="group" aria-label="Changes apply to">
            <button className="chip" aria-pressed={!allSnapshots} onClick={() => onAllSnapshots(false)}>{snap.name}</button>
            <button className="chip" aria-pressed={allSnapshots} onClick={() => onAllSnapshots(true)}>All snapshots</button>
          </div>
        </div>
      )}
      {def.nam && <DeviceSetting value={block.nam ?? null} files={files} onChange={(id) => onFile('nam', 0, id)} />}
      {def.nam && <FilePick kind="nam" role={def.nam} value={block.nam ?? null} files={files} onChange={(id) => onFile('nam', 0, id)} />}
      {Array.from({ length: def.irSlots ?? 0 }, (_, s) => (
        <div key={s} style={{ display: 'grid', gap: 6 }}>
        <DeviceSetting value={block.ir?.[s] ?? null} files={files} onChange={(id) => onFile('ir', s, id)} />
        <FilePick kind="ir" label={def.irSlots! > 1 ? `IR ${'AB'[s]}` : undefined} value={block.ir?.[s] ?? null} files={files} onChange={(id) => onFile('ir', s, id)} />
        </div>
      ))}
      {def.category === 'looper' ? <LooperControls block={block} state={m.states[live.blockIndex(block.uid) ?? -1] ?? 0} /> : null}
      <div className="faceplate">
        <div className="knobs">
          {def.params.map((p) => {
            const mm = mapping(p.id);
            return (
              <div key={p.id} className="pwrap">
                <ParamKnob p={p} value={st.params[p.id] ?? p.def} overridden={p.id in over} onChange={(v) => { onParam(p.id, v); live.param(block.uid, p.id, block.type, v); }} />
                {live.running && (
                  <button className={'learn' + (live.learning?.kind === 'param' && live.learning.uid === block.uid && live.learning.param === p.id ? ' on' : '')}
                    title={mm ? `MIDI ${mm.source.type.toUpperCase()} ${mm.source.number} (ch ${mm.source.channel}); click to learn again` : p.expression ? 'Assign an expression pedal or MIDI control' : 'MIDI learn'}
                    onClick={() => live.learn({ kind: 'param', uid: block.uid, param: p.id, min: p.min, max: p.max, label: `${block.label || def.name} ${p.label}` })}>
                    {mm ? `${mm.source.type === 'cc' ? 'CC' : 'N'}${mm.source.number}` : p.expression ? 'EXP' : 'MIDI'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="row">
        {def.timeBased && (
          <label className="row" style={{ gap: 6 }} title="Keep delay and reverb tails ringing when the block is switched off or a snapshot changes">
            <input type="checkbox" checked={block.trails !== false} onChange={(e) => onTrails(e.target.checked)} /> Trails
          </label>
        )}
        {live.running && (
          <button className={'btn sm' + (live.learning?.kind === 'bypass' && live.learning.uid === block.uid ? ' on' : '')}
            onClick={() => live.learn({ kind: 'bypass', uid: block.uid, label: `${block.label || def.name} on/off` })}>Learn footswitch</button>
        )}
        <span className="grow" />
        <button className="btn sm ghost" onClick={onDuplicate}>Duplicate</button>
        <button className="btn sm ghost danger" onClick={onRemove}>{Icon.trash({ size: 14 })} Remove</button>
      </div>
    </div>
  );
}

function LooperControls({ block, state }: { block: RigBlock; state: number }) {
  const live = useLive();
  const mode = state & 7;
  const label = ['Empty', 'Recording', 'Playing', 'Overdubbing', 'Stopped'][mode] ?? '';
  const act = (a: number) => live.trigger(block.uid, a);
  if (!live.running) return <p className="muted" style={{ margin: 0 }}>Start the live engine to use the looper.</p>;
  return (
    <div className="looper">
      <span className={'loopstate s' + mode}>{label}{state & 8 ? ' · half speed' : ''}{state & 16 ? ' · reverse' : ''}</span>
      <div className="row">
        <button className="btn" onClick={() => act(0)}>{mode === 0 ? 'Record' : mode === 1 ? 'Play' : mode === 3 ? 'Play' : 'Overdub'}</button>
        <button className="btn" onClick={() => act(1)}>{mode === 4 ? 'Play' : 'Stop'}</button>
        <button className="btn" onClick={() => act(2)} disabled={!(state & 32)}>Undo</button>
        <button className="btn" onClick={() => act(3)}>Clear</button>
        <button className={'btn' + (state & 8 ? ' on' : '')} onClick={() => act(4)}>½ speed</button>
        <button className={'btn' + (state & 16 ? ' on' : '')} onClick={() => act(5)}>Reverse</button>
      </div>
    </div>
  );
}

/** a device with several captures: switch its setting like a knob position */
function DeviceSetting({ value, files, onChange }: { value: string | null; files: RigFile[]; onChange(id: string): void }) {
  const dev = useMemo(() => {
    const cur = files.find((f) => f.id === value);
    return cur?.device ? captureDevices(files).find((d) => d.files.some((f) => f.id === cur.id)) : undefined;
  }, [files, value]);
  if (!dev || dev.files.length < 2) return null;
  return (
    <div className="field">
      <span>{dev.name} setting</span>
      {dev.files.length <= 4 ? (
        <div className="seg" role="radiogroup" aria-label={`${dev.name} setting`}>
          {dev.files.map((f) => <button key={f.id} role="radio" aria-checked={f.id === value} onClick={() => onChange(f.id)}>{f.setting}</button>)}
        </div>
      ) : (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={`${dev.name} setting`}>
          {dev.files.map((f) => <option key={f.id} value={f.id}>{f.setting}</option>)}
        </select>
      )}
    </div>
  );
}

function FilePick({ kind, role, label, value, files, onChange }: { kind: 'nam' | 'ir'; role?: NamRole; label?: string; value: string | null; files: RigFile[]; onChange(id: string | null): void }) {
  const { pick, busy } = useUpload(kind, role);
  const list = useMemo(() => files.filter((f) => f.kind === kind), [files, kind]);
  const groups = kind === 'ir' ? [{ label: 'Impulse responses', items: list }] : [
    { label: `${roleLabel(role)} captures`, items: list.filter((f) => (f.role ?? 'amp') === role) },
    ...NAM_ROLES.filter((r) => r.id !== role).map((r) => ({ label: `${r.label} captures`, items: list.filter((f) => (f.role ?? 'amp') === r.id) })),
  ].filter((g) => g.items.length);
  const cur = files.find((f) => f.id === value);
  return (
    <div className="field">
      <span>{label ?? (kind === 'ir' ? 'Impulse response' : `${roleLabel(role)} model`)}</span>
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <select className="grow" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={label ?? (kind === 'ir' ? 'Impulse response' : 'Model')}>
          <option value="">{kind === 'ir' ? 'No IR' : 'No model'}</option>
          {groups.map((g) => <optgroup key={g.label} label={g.label}>{g.items.map((f) => <option key={f.id} value={f.id}>{f.device ? `${f.device} · ${f.setting ?? f.name}` : f.name}</option>)}</optgroup>)}
        </select>
        <button className="btn sm" onClick={() => pick((added) => { const f = added.find((x) => x.kind === kind); if (f) onChange(f.id); })} disabled={busy} title="Add files (.nam, .wav or .zip)">{busy ? <span className="spinner" /> : Icon.upload({ size: 14 })}</button>
        <button className="btn sm" onClick={() => go(`/rig/find${kind === 'ir' ? '?type=ir' : role ? `?type=${role}` : ''}`)} title="Find models online">{Icon.search({ size: 14 })}</button>
      </div>
      {cur && <span className="faint" style={{ fontSize: 12 }}>{[cur.gearMake, cur.gearModel].filter(Boolean).join(' ')}{cur.author ? ` · by ${cur.author}` : ''}{cur.source?.kind === 'tone3000' ? ' · TONE3000' : ''}</span>}
    </div>
  );
}

export function SplitPanel({ split, onChange, onRemove, onClose }: { split: RigSplit; onChange(fn: (s: RigSplit) => void): void; onRemove(): void; onClose(): void }) {
  const amountDef: ParamDef | null = split.split === 'ab' ? { id: 'amount', label: 'Balance', min: -1, max: 1, def: 0, unit: '', step: 0.01 }
    : split.split === 'crossover' ? { id: 'amount', label: 'Frequency', min: 80, max: 8000, def: 800, unit: 'Hz', log: true, step: 1 }
      : split.split === 'dynamic' ? { id: 'amount', label: 'Threshold', min: -70, max: 0, def: -30, unit: 'dB', step: 0.5 } : null;
  const m = split.merge;
  const db = (id: string, label: string): ParamDef => ({ id, label, min: -40, max: 12, def: 0, unit: 'dB', step: 0.1 });
  const pan = (id: string, label: string): ParamDef => ({ id, label, min: -1, max: 1, def: 0, unit: '', step: 0.01 });
  return (
    <div className="bpanel" style={{ ['--cat' as string]: '#8C8F99' }}>
      <header>
        <div className="grow"><b>Split and merge</b><div className="faint" style={{ fontSize: 12 }}>Two lanes that run side by side and mix back together</div></div>
        <button className="iconbtn" onClick={onClose} aria-label="Close">{Icon.close({ size: 16 })}</button>
      </header>
      <div className="chips" role="radiogroup" aria-label="Split type">
        {([['y', 'Y (both lanes)'], ['ab', 'A/B balance'], ['crossover', 'Crossover'], ['dynamic', 'Dynamic']] as const).map(([k, l]) => (
          <button key={k} className="chip" role="radio" aria-checked={split.split === k} aria-pressed={split.split === k}
            onClick={() => onChange((s) => { s.split = k; s.amount = k === 'crossover' ? 800 : k === 'dynamic' ? -30 : 0; })}>{l}</button>
        ))}
      </div>
      <div className="faceplate">
        <div className="knobs">
          {amountDef && <ParamKnob p={amountDef} value={split.amount} onChange={(v) => onChange((s) => { s.amount = v; })} />}
          <ParamKnob p={db('la', 'Level A')} value={m.levelA} onChange={(v) => onChange((s) => { s.merge.levelA = v; })} />
          <ParamKnob p={db('lb', 'Level B')} value={m.levelB} onChange={(v) => onChange((s) => { s.merge.levelB = v; })} />
          <ParamKnob p={pan('pa', 'Pan A')} value={m.panA} onChange={(v) => onChange((s) => { s.merge.panA = v; })} />
          <ParamKnob p={pan('pb', 'Pan B')} value={m.panB} onChange={(v) => onChange((s) => { s.merge.panB = v; })} />
        </div>
      </div>
      <div className="row">
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={m.invertB} onChange={(e) => onChange((s) => { s.merge.invertB = e.target.checked; })} /> Flip lane B polarity</label>
        <span className="grow" />
        <button className="btn sm ghost danger" onClick={onRemove}>Remove split (keep blocks)</button>
      </div>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>
        {split.split === 'y' ? 'Both lanes get the full signal.' : split.split === 'ab' ? 'Turn left for more lane A, right for more lane B.' : split.split === 'crossover' ? 'Lows go to lane A, highs to lane B.' : 'Quiet playing goes to lane A, loud playing to lane B.'}
      </p>
    </div>
  );
}

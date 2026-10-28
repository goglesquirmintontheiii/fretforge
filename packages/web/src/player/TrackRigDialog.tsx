// Which rig a tab track plays through, and where it switches rigs or snapshots.
import { useEffect, useState } from 'react';
import { ampToRig, starterRig, type AmpSettings, type RigDoc, type TrackRig } from '@fretforge/shared';
import { api } from '../api';
import { go, useApp } from '../lib/app';
import { Icon } from '../components/icons';
import { putLocalRig, useRigs } from '../rig/rigStore';
import { useLive } from '../rig/LiveRig';
import type { TrackAudioState } from './useEngine';

export function TrackRigDialog({ trackName, value, legacyAmp, state, currentBar, barCount, onChange, onEditLegacy, onRemoveLegacy, onClose, mode = 'track', sections = [] }: {
  trackName: string; value: TrackRig | undefined; legacyAmp: AmpSettings | undefined; state?: TrackAudioState;
  currentBar: number; barCount: number;
  onChange(v: TrackRig | null): void; onEditLegacy(): void; onRemoveLegacy(): void; onClose(): void;
  /** 'live': the rig your own guitar plays through during this song */
  mode?: 'track' | 'live';
  sections?: { bar: number; text: string }[];
}) {
  const isLive = mode === 'live';
  const { toast } = useApp();
  const live = useLive();
  const rigs = useRigs() ?? [];
  const [tr, setTr] = useState<TrackRig>(() => value ?? { rigId: null, enabled: true, switches: [] });
  const set = (next: TrackRig) => { setTr(next); onChange(next.rigId || next.switches?.length ? next : null); };
  const rig = rigs.find((r) => r.id === tr.rigId);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [onClose]);

  const createRig = async (base: RigDoc) => {
    try {
      const r = await api.createRig(base);
      putLocalRig(r);
      return r;
    } catch (e) { toast((e as Error).message); return null; }
  };
  const switches = tr.switches ?? [];
  const setSwitch = (i: number, patch: Partial<NonNullable<TrackRig['switches']>[number]>) => {
    const next = switches.map((s, j) => (j === i ? { ...s, ...patch } : s)).sort((a, b) => a.bar - b.bar);
    set({ ...tr, switches: next });
  };
  const snapOptions = (r: RigDoc | undefined) => (r?.snapshots ?? []).map((s, i) => <option key={i} value={i}>{i + 1}. {s.name}</option>);

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label={`Rig for ${trackName}`}>
        <header>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 18 }}>{isLive ? 'Your rig for this song' : `Rig · ${trackName}`}</h2>
            <span className="muted" style={{ fontSize: 13 }}>
              {isLive ? 'Your guitar plays through it live. It switches rigs or snapshots at the bars you set while the song plays.' : state?.phase === 'amp' ? `Running the rig… ${Math.round(state.progress * 100)}%` : state?.phase === 'rendering' ? 'Rendering the track…' : state?.phase === 'error' ? state.message : 'The track’s synth sound runs through a rig from your rig editor'}
            </span>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={tr.enabled !== false} onChange={(e) => set({ ...tr, enabled: e.target.checked })} /> On</label>
            <button className="iconbtn" onClick={onClose} aria-label="Close">{Icon.close()}</button>
          </div>
        </header>

        {!isLive && legacyAmp && !value && (
          <div className="engstat" style={{ display: 'grid', gap: 8 }}>
            <span>This track uses an amp set up in Fretforge 0.4. It keeps playing as it is; turn it into a rig to add pedals and effects.</span>
            <div className="row">
              <button className="btn sm primary" onClick={async () => {
                const r = await createRig({ ...ampToRig(legacyAmp, `${trackName} amp`), id: '' });
                if (r) { set({ rigId: r.id, enabled: true, switches: [] }); onRemoveLegacy(); toast(`Made the rig “${r.name}”`); }
              }}>Turn it into a rig</button>
              <button className="btn sm" onClick={onEditLegacy}>Edit the classic amp</button>
              <button className="btn sm ghost danger" onClick={onRemoveLegacy}>Remove it</button>
            </div>
          </div>
        )}

        <div className="iogrid">
          <label className="field"><span>Rig</span>
            <select value={tr.rigId ?? ''} onChange={(e) => set({ ...tr, rigId: e.target.value || null, snapshot: undefined })} id="track-rig">
              <option value="">None (dry)</option>
              {rigs.map((r) => <option key={r.id} value={r.id}>{r.name}{r.ownerName && r.shared ? ` (${r.ownerName})` : ''}</option>)}
            </select>
          </label>
          {rig && rig.snapshots.length > 1 && (
            <label className="field"><span>Snapshot</span>
              <select value={tr.snapshot ?? rig.snapshot} onChange={(e) => set({ ...tr, snapshot: Number(e.target.value) })}>{snapOptions(rig)}</select>
            </label>
          )}
          <div className="field"><span>&nbsp;</span>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" onClick={async () => { const r = await createRig(starterRig(`${trackName} rig`)); if (r) set({ ...tr, rigId: r.id }); }}>{Icon.plus({ size: 14 })} New rig</button>
              {rig && <button className="btn sm" onClick={() => go(`/rig/r/${rig.id}`)}>{Icon.edit({ size: 14 })} Edit rig</button>}
            </div>
          </div>
        </div>

        <section style={{ display: 'grid', gap: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>Switches</b>
            <span className="row" style={{ gap: 6 }}>
            {sections.length > 0 && (
              <button className="btn sm" title="One switch at the start of every section; pick a snapshot for each" onClick={() => {
                const have = new Set(switches.map((x) => x.bar));
                const add = sections.filter((x) => x.bar > 0 && !have.has(x.bar)).map((x) => ({ bar: x.bar, rigId: undefined, snapshot: rig ? tr.snapshot ?? rig.snapshot : undefined }));
                set({ ...tr, switches: [...switches, ...add].sort((a, b) => a.bar - b.bar) });
              }}>At every section</button>
            )}
            <button className="btn sm" onClick={() => set({ ...tr, switches: [...switches, { bar: Math.min(barCount - 1, Math.max(0, currentBar)), rigId: undefined, snapshot: rig && rig.snapshots.length > 1 ? Math.min(rig.snapshots.length - 1, (tr.snapshot ?? rig.snapshot) + 1) : undefined }].sort((a, b) => a.bar - b.bar) })}>
              {Icon.plus({ size: 14 })} Switch at bar {Math.max(1, currentBar + 1)}
            </button>
            </span>
          </div>
          {switches.length === 0 ? <p className="faint" style={{ margin: 0, fontSize: 13 }}>Change to another rig or snapshot from a bar on, for a chorus, a solo or a clean intro. Delays and reverbs ring out across the switch.</p> : (
            <div className="switches">
              {switches.map((s, i) => {
                const target = s.rigId !== undefined ? rigs.find((r) => r.id === s.rigId) : rig;
                return (
                  <div className="row switchrow" key={i}>
                    {sections.find((x) => x.bar === s.bar) && <span className="badge">{sections.find((x) => x.bar === s.bar)!.text}</span>}
                    <label className="row" style={{ gap: 6 }}>From bar
                      <input type="number" min={1} max={barCount} value={s.bar + 1} onChange={(e) => setSwitch(i, { bar: Math.max(0, Math.min(barCount - 1, (Number(e.target.value) || 1) - 1)) })} style={{ width: 72 }} aria-label="Bar" />
                    </label>
                    <select value={s.rigId === undefined ? '__same' : s.rigId ?? ''} onChange={(e) => setSwitch(i, e.target.value === '__same' ? { rigId: undefined } : { rigId: e.target.value || null, snapshot: undefined })} aria-label="Rig">
                      <option value="__same">Same rig</option>
                      <option value="">None (dry)</option>
                      {rigs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                    {target && target.snapshots.length > 1 && (
                      <select value={s.snapshot ?? target.snapshot} onChange={(e) => setSwitch(i, { snapshot: Number(e.target.value) })} aria-label="Snapshot">{snapOptions(target)}</select>
                    )}
                    <button className="iconbtn" aria-label="Remove switch" onClick={() => set({ ...tr, switches: switches.filter((_, j) => j !== i) })}>{Icon.trash({ size: 15 })}</button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <div className="row" style={{ justifyContent: 'space-between' }}>
          {rig ? (
            <button className="btn sm" onClick={async () => { live.play(rig); if (!live.running) await live.start(); toast(`Playing your guitar through “${rig.name}”`); }}>{Icon.power({ size: 14 })} {isLive && live.running ? 'Play it now' : 'Play along live with this rig'}</button>
          ) : <span />}
          {(tr.rigId || switches.length > 0) && <button className="btn sm danger" onClick={() => { setTr({ rigId: null, enabled: true, switches: [] }); onChange(null); }}>Remove rig</button>}
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>{isLive
          ? 'Snapshot changes are instant and delays and reverbs ring out; a different rig crossfades in. Switches happen while the song plays with the live rig on.'
          : 'The track is rendered once and run through its rigs in the background, so playback stays light. Changes to a rig in the editor apply the next time the tab plays.'}</p>
      </div>
    </div>
  );
}

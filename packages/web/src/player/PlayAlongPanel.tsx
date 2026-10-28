// Play along: your live rig for this song (with switches at bars), the main and headphone
// mixes, and takes: record the dry guitar, the rig and the song together, re-amp a DI through
// any rig later, export WAVs or a mixed MP3.
import { ToneMatchCard } from './ToneMatch';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AudioAsset, RigDoc, SongRecord, TrackRig } from '@fretforge/shared';
import { api } from '../api';
import { useApp } from '../lib/app';
import { Icon } from '../components/icons';
import { useLive, useLiveMeters } from '../rig/LiveRig';
import { exportMix, exportPart, reampTake, saveTake, TakeRecorder, type TakeData } from '../audio/takes';
import { formatTime } from '@fretforge/shared';

export function PlayAlongPanel({ song, liveRig, rigs, onEditLiveRig, takes, onTakesChanged, songReady, preparing, playing, onPlay, onPause, tempo, accuracy, files, onUseLive }: {
  song: SongRecord;
  /** the song's recordings and stems (tone match uses the guitar stem) */
  files: AudioAsset[];
  onUseLive(rigId: string): void;
  liveRig: TrackRig | undefined;
  rigs: RigDoc[];
  onEditLiveRig(): void;
  takes: AudioAsset[];
  onTakesChanged(): void;
  /** the song plays through the engine (needed to record it) */
  songReady: boolean;
  preparing: string | null;
  playing: boolean;
  onPlay(): void;
  onPause(): void;
  tempo: number;
  /** the coach's score while it listens */
  accuracy: number | null;
}) {
  const { toast } = useApp();
  const live = useLive();
  const m = useLiveMeters();
  const rec = useRef<TakeRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [secs, setSecs] = useState(0);
  const [pending, setPending] = useState<TakeData | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const rigNow = live.rig;
  const songRig = liveRig?.rigId ? rigs.find((r) => r.id === liveRig.rigId) : undefined;

  useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(() => setSecs(rec.current?.seconds ?? 0), 250);
    return () => window.clearInterval(t);
  }, [recording]);
  // stop recording when the song stops on its own
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (recording && wasPlaying.current && !playing) void stop();
    wasPlaying.current = playing;
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (rec.current) { rec.current.stop(); live.releaseTap(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    if (!live.running) await live.start();
    const tap = live.acquireTap();
    if (!tap) { toast('Start the live rig first.'); return; }
    rec.current = new TakeRecorder(tap);
    rec.current.start();
    setRecording(true);
    setSecs(0);
    if (!playing) onPlay();
  };
  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setRecording(false);
    const data = r.stop();
    live.releaseTap();
    onPause();
    if (!data || data.di.length < data.sampleRate) { toast('The take was too short to keep.'); return; }
    setPending(data);
    setLabel(`Take ${new Set(takes.map((t) => t.take?.group)).size + 1}`);
  };
  const save = async () => {
    if (!pending) return;
    setBusy('Saving the take…');
    try {
      await saveTake(song.id, pending, rigNow, label.trim() || 'Take', accuracy ?? undefined);
      setPending(null);
      onTakesChanged();
      toast('Take saved');
    } catch (e) { toast((e as Error).message); } finally { setBusy(null); }
  };

  const groups = useMemo(() => {
    const g = new Map<string, AudioAsset[]>();
    for (const t of [...takes].sort((a, b) => b.createdAt - a.createdAt)) {
      const k = t.take?.group ?? t.id;
      g.set(k, [...(g.get(k) ?? []), t]);
    }
    return [...g.values()];
  }, [takes]);

  const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -60);
  const slider = (label: string, v: number, set: (x: number) => void, id: string) => (
    <label className="mixrow" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
      <span><span className="nm">{label}</span> <span className="db">{db(v) <= -59 ? '−∞' : `${db(v).toFixed(1)} dB`}</span></span>
      <input type="range" id={id} min={0} max={1.5} step={0.01} value={v} onChange={(e) => set(Number(e.target.value))} onDoubleClick={() => set(1)} aria-label={label} />
    </label>
  );

  return (
    <div className="side-pane playalong">
      <section className="pa-card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <b>Your rig</b>
          {live.running
            ? <span className="badge good" title={live.kind === 'native' ? 'The song and your rig play in the same engine' : 'The song and your rig share the browser’s audio clock'}>{live.kind === 'native' ? 'JACK' : 'Browser'}{live.latencyMs ? ` · ${Math.round(live.latencyMs)} ms` : ''}</span>
            : <span className="badge">Off</span>}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="nm" style={{ display: 'block' }}>{songRig?.name ?? rigNow?.name ?? 'No rig chosen'}</span>
            <span className="faint" style={{ fontSize: 12 }}>{songRig ? `${liveRig?.switches?.length ? `${liveRig.switches.length} switch${liveRig.switches.length === 1 ? '' : 'es'} · ` : ''}saved with this song` : rigNow ? 'the rig that’s playing now' : 'pick one for this song'}</span>
          </span>
          <button className="btn sm" onClick={onEditLiveRig}>{songRig ? 'Change' : 'Choose'}</button>
          <button className={'btn sm ' + (live.running ? 'on' : 'primary')} disabled={live.starting} onClick={() => (live.running ? live.stop() : live.start())}>
            {live.starting ? <span className="spinner" /> : Icon.power({ size: 14 })} {live.running ? 'Live' : 'Play live'}
          </button>
        </div>
        {live.running && (
          <div className="pa-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, (db(m.input) + 60) / 60 * 100))}%` }} /></div>
        )}
      </section>

      {live.running && (
        <section className="pa-card">
          <b>Mix</b>
          {slider('Song', live.mix.mainSong, (x) => live.setMix({ mainSong: x }), 'mix-song')}
          {slider('Your rig', live.mix.mainRig, (x) => live.setMix({ mainRig: x }), 'mix-rig')}
          {live.kind === 'native' ? (
            <details>
              <summary className="faint" style={{ fontSize: 13, cursor: 'pointer' }}>Headphones (second output)</summary>
              {slider('Song', live.mix.phonesSong, (x) => live.setMix({ phonesSong: x }), 'mix-phsong')}
              {slider('Your rig', live.mix.phonesRig, (x) => live.setMix({ phonesRig: x }), 'mix-phrig')}
              <p className="faint" style={{ margin: 0, fontSize: 12 }}>Connect the engine’s phones_L/phones_R ports to your headphone output in the rig’s Audio and MIDI panel or a patchbay.</p>
            </details>
          ) : <p className="faint" style={{ margin: 0, fontSize: 12 }}>A separate headphone mix needs the desktop app’s low-latency engine.</p>}
        </section>
      )}

      <section className="pa-card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <b>Takes</b>
          {recording ? (
            <button className="btn sm danger" onClick={() => void stop()}><span className="recdot" /> Stop · {formatTime(secs * 1000)}</button>
          ) : (
            <button className="btn sm" disabled={!!pending || (!songReady && live.running) || !!busy} onClick={() => void start()} title={live.running ? 'Records your DI, the rig and the song from the playback position' : 'Starts the live rig and records'}>
              <span className="recdot" /> Record
            </button>
          )}
        </div>
        {preparing && !songReady && live.running && <span className="faint" style={{ fontSize: 12 }}>{preparing}…</span>}
        {pending && (
          <div className="pa-pending">
            <label className="field"><span>Name</span><input type="text" id="take-name" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
            <span className="faint" style={{ fontSize: 12 }}>{formatTime((pending.di.length / pending.sampleRate) * 1000)}{accuracy !== null ? ` · coach ${Math.round(accuracy * 100)}%` : ''}</span>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm primary" disabled={!!busy} onClick={() => void save()}>{busy ? <span className="spinner" /> : null} Save</button>
              <button className="btn sm ghost" disabled={!!busy} onClick={() => setPending(null)}>Discard</button>
            </div>
          </div>
        )}
        {busy && !pending && <span className="faint" style={{ fontSize: 12 }}><span className="spinner" /> {busy}</span>}
        {groups.length === 0 && !pending && <p className="faint" style={{ margin: 0, fontSize: 13 }}>Record yourself playing along. The dry guitar is kept too, so you can re-amp it through another rig later. Takes are only visible to you.</p>}
        {groups.map((g) => <TakeRow key={g[0].take?.group ?? g[0].id} parts={g} rigs={rigs} songId={song.id} tempo={tempo} onChanged={onTakesChanged} setBusy={setBusy} busy={busy} />)}
      </section>

      <ToneMatchCard song={song} files={files} takes={takes} tempo={tempo} onUseLive={onUseLive} />
    </div>
  );
}

function TakeRow({ parts, rigs, songId, tempo, onChanged, setBusy, busy }: {
  parts: AudioAsset[]; rigs: RigDoc[]; songId: string; tempo: number; onChanged(): void; setBusy(b: string | null): void; busy: string | null;
}) {
  const { toast } = useApp();
  const [open, setOpen] = useState(false);
  const [reampRig, setReampRig] = useState('');
  const di = parts.find((p) => p.take?.part === 'di');
  const song = parts.find((p) => p.take?.part === 'song');
  const guitars = parts.filter((p) => p.take?.part === 'rig' || p.take?.part === 'reamp');
  const [mixWith, setMixWith] = useState(guitars[0]?.id ?? '');
  const name = (di ?? parts[0]).name.replace(/ · (DI|Song|.*)$/, '');
  const t = parts[0].take;
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    try { await f(); } catch (e) { toast((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <div className={`asset take${open ? ' open' : ''}`}>
      <button className="takehead" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span style={{ minWidth: 0 }}>
          <span className="nm">{name}</span>
          <span className="faint" style={{ fontSize: 12, display: 'block' }}>
            {new Date(parts[0].createdAt).toLocaleString()} · {formatTime(parts[0].durationMs ?? 0)}{t?.accuracy !== undefined ? ` · coach ${Math.round(t.accuracy * 100)}%` : ''}
          </span>
        </span>
        <span>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div style={{ display: 'grid', gap: 8 }}>
          {guitars.map((p) => (
            <div key={p.id} className="takepart">
              <span className="faint" style={{ fontSize: 12 }}>{p.take?.part === 'reamp' ? 'Re-amp' : 'Rig'}: {p.take?.rigName ?? '—'}</span>
              <audio controls preload="none" src={`/api/audio/${p.id}/raw`} />
            </div>
          ))}
          {di && (
            <div className="row" style={{ gap: 6 }}>
              <select value={reampRig} onChange={(e) => setReampRig(e.target.value)} aria-label="Re-amp through">
                <option value="">Re-amp the DI through…</option>
                {rigs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <button className="btn sm" disabled={!reampRig || !!busy} onClick={() => run('Re-amping…', async () => {
                const rig = rigs.find((r) => r.id === reampRig)!;
                await reampTake(songId, di, rig, rig.snapshot, tempo, (f) => setBusy(`Re-amping… ${Math.round(f * 100)}%`));
                setReampRig('');
                onChanged();
              })}>Re-amp</button>
            </div>
          )}
          <div className="row" style={{ gap: 6 }}>
            {guitars.length > 1 && (
              <select value={mixWith} onChange={(e) => setMixWith(e.target.value)} aria-label="Guitar for the mix">
                {guitars.map((g) => <option key={g.id} value={g.id}>{g.take?.part === 'reamp' ? 'Re-amp' : 'Rig'}: {g.take?.rigName}</option>)}
              </select>
            )}
            {song && guitars.length > 0 && (
              <>
                <button className="btn sm" disabled={!!busy} onClick={() => run('Mixing…', () => exportMix(guitars.find((g) => g.id === mixWith) ?? guitars[0], song, { format: 'mp3', guitarGain: 1, songGain: 0.8, name }, (f) => setBusy(`Making the MP3… ${Math.round(f * 100)}%`)))}>{Icon.download({ size: 14 })} MP3 mix</button>
                <button className="btn sm ghost" disabled={!!busy} onClick={() => run('Mixing…', () => exportMix(guitars.find((g) => g.id === mixWith) ?? guitars[0], song, { format: 'wav', guitarGain: 1, songGain: 0.8, name }, () => {}))}>WAV mix</button>
              </>
            )}
          </div>
          <div className="row" style={{ gap: 6 }}>
            {parts.map((p) => <button key={p.id} className="btn sm ghost" onClick={() => run('Downloading…', () => exportPart(p))}>{p.take?.part === 'di' ? 'DI' : p.take?.part === 'song' ? 'Song' : p.take?.part === 'reamp' ? `Re-amp (${p.take.rigName})` : 'Rig'}.wav</button>)}
            <button className="btn sm ghost danger" onClick={() => run('Removing…', async () => { for (const p of parts) await api.deleteAudio(p.id); onChanged(); })}>{Icon.trash({ size: 14 })} Delete</button>
          </div>
          {t && <p className="faint" style={{ margin: 0, fontSize: 12 }}>The guitar parts are lined up with the song in the mixes ({Math.round(t.latencyMs)} ms latency removed).</p>}
        </div>
      )}
    </div>
  );
}

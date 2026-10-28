import { useEffect, useRef, useState } from 'react';
import * as alphaTab from '@coderline/alphatab';
import { encodeWav, formatTime, type AudioAsset, type Job, type PlaySource, type SyncPoint } from '@fretforge/shared';
import { api, type ApiError } from '../api';
import { YtdlpInstall } from '../components/YtdlpInstall';
import { useApp } from '../lib/app';
import { Icon } from '../components/icons';
import { Timeline } from '../audio/tabAudio';
import { askConfirm } from '../lib/dialog';

const STEM_ORDER = ['vocals', 'lead-guitar', 'rhythm-guitar', 'guitar', 'bass', 'drums', 'piano', 'other'];

/** Polls the job list while anything for this song is running. */
export function useJobs(songId?: string) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [ai, setAi] = useState<{ available: boolean; device: string | null; reason?: string } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    let t: number | undefined;
    const poll = async () => {
      try {
        const r = await api.jobs();
        if (!alive) return;
        const mine = songId ? r.jobs.filter((j) => j.songId === songId) : r.jobs;
        setJobs(mine);
        setAi(r.ai);
        const busy = mine.some((j) => j.state === 'queued' || j.state === 'running');
        t = window.setTimeout(poll, busy ? 1500 : 8000);
      } catch {
        t = window.setTimeout(poll, 10000);
      }
    };
    poll();
    return () => { alive = false; window.clearTimeout(t); };
  }, [songId, tick]);
  return { jobs, ai, refresh: () => setTick((x) => x + 1) };
}

function eta(j: Job): string {
  if (j.state !== 'running' || !j.startedAt || j.progress < 0.04) return '';
  const left = ((Date.now() - j.startedAt) * (1 - j.progress)) / j.progress / 1000;
  if (left < 60) return ' · under a minute left';
  if (left < 3600) return ` · about ${Math.round(left / 60)} min left`;
  return ` · about ${(left / 3600).toFixed(1)} h left`;
}

export function JobRow({ j, onCancel }: { j: Job; onCancel?: () => void }) {
  const active = j.state === 'queued' || j.state === 'running';
  return (
    <div className="jobrow">
      <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
        <b style={{ fontSize: 13 }}>{j.label}</b>
        <span className={'badge ' + (j.state === 'done' ? 'good' : j.state === 'failed' ? 'bad' : active ? 'info' : '')}>{j.state === 'running' ? `${Math.round(j.progress * 100)}%` : j.state}</span>
      </div>
      {active && <div className="bar"><i style={{ width: `${Math.max(2, j.progress * 100)}%` }} /></div>}
      <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
        <span className="faint" style={{ fontSize: 12 }}>{j.message}{eta(j)}</span>
        {active && onCancel && <button className="btn ghost sm" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

export function AudioPanel({ songId, audio, onAudioChanged, playSource, setPlaySource, api: at, audioMs, canEdit, videoId, setVideoId, fromSongsterr }: {
  songId: string; audio: AudioAsset[]; onAudioChanged: () => void; playSource: PlaySource; setPlaySource: (s: PlaySource) => void;
  api: alphaTab.AlphaTabApi | null; audioMs: () => number; canEdit: boolean;
  videoId: string | null; setVideoId: (id: string) => void; fromSongsterr: boolean;
}) {
  const { toast } = useApp();
  const { jobs, ai, refresh } = useJobs(songId);
  const [busy, setBusy] = useState(false);
  const [yt, setYt] = useState('');
  const [ytCheck, setYtCheck] = useState(0);
  const [syncing, setSyncing] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastDone = useRef<string>('');

  // new stems or sync points land through jobs: reload the list when one finishes
  useEffect(() => {
    const done = jobs.filter((j) => j.state === 'done').map((j) => j.id).join();
    if (lastDone.current && done !== lastDone.current) onAudioChanged();
    lastDone.current = done;
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (fs: File[]) => {
    if (!fs.length) return;
    setBusy(true);
    try {
      await api.uploadAudio(songId, fs);
      onAudioChanged();
      toast('Recording added');
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };

  const originals = audio.filter((a) => a.kind === 'original');
  const videos = audio.filter((a) => a.kind === 'video');
  const files = audio.filter((a) => a.kind === 'original' || a.kind === 'stem');
  const addVideo = async () => {
    try {
      const v = await api.addVideo(songId, yt.trim());
      setYt('');
      onAudioChanged();
      setVideoId(v.id);
      setPlaySource('video');
    } catch (err) { toast((err as Error).message); }
  };
  const findSongsterr = async () => {
    setBusy(true);
    try {
      const r = await api.songsterrVideos(songId);
      onAudioChanged();
      toast(r.videos.length ? `Found ${r.videos.length} video${r.videos.length === 1 ? '' : 's'} synced on Songsterr` : 'Songsterr has no synced videos for this tab.');
      if (r.videos.length && !videoId) setVideoId(r.videos[0].id);
    } catch (err) { toast((err as Error).message); } finally { setBusy(false); }
  };
  const stemsOf = (id: string) => audio.filter((a) => a.parentId === id).sort((a, b) => STEM_ORDER.indexOf(a.stem ?? '') - STEM_ORDER.indexOf(b.stem ?? ''));
  const activeJobs = jobs.filter((j) => j.state === 'queued' || j.state === 'running');

  return (
    <div className="side-pane">
      {audio.length > 0 && (
        <div className="chips" role="group" aria-label="What plays">
          <button className="chip" aria-pressed={playSource === 'tab'} onClick={() => setPlaySource('tab')}>Tab sound</button>
          {files.length > 0 && <button className="chip" aria-pressed={playSource === 'recording'} onClick={() => setPlaySource('recording')}>Recording</button>}
          {videos.length > 0 && <button className="chip" aria-pressed={playSource === 'video'} onClick={() => { if (!videoId) setVideoId(videos[0].id); setPlaySource('video'); }}>Video</button>}
        </div>
      )}
      {videos.length > 0 && (
        <div className="videolist" role="radiogroup" aria-label="Videos">
          {videos.map((v) => {
            const on = playSource === 'video' && videoId === v.id;
            return (
              <div key={v.id} className={`asset video${on ? ' on' : ''}`}>
                <div className="row" style={{ justifyContent: 'space-between', gap: 6, flexWrap: 'nowrap' }}>
                  <button className="vpick" role="radio" aria-checked={on} onClick={() => { setVideoId(v.id); setPlaySource('video'); }}>
                    <img src={`https://i.ytimg.com/vi/${v.youtubeId}/mqdefault.jpg`} alt="" loading="lazy" width={64} height={36} />
                    <span style={{ minWidth: 0 }}>
                      <span className="nm" title={v.name}>{v.name}</span>
                      <span className="faint" style={{ fontSize: 12, display: 'block' }}>
                        {v.syncPoints.length ? `synced (${v.syncPoints.length} points)` : v.barPoints?.length ? 'synced by Songsterr' : v.offsetMs ? `offset ${v.offsetMs} ms` : 'not synced'}
                        {v.offsetMs && (v.barPoints?.length || v.syncPoints.length) ? ` · ${v.offsetMs > 0 ? '+' : ''}${v.offsetMs} ms` : ''}
                      </span>
                    </span>
                  </button>
                  {canEdit && <button className="iconbtn" aria-label={`Remove ${v.name}`} onClick={async () => { if (await askConfirm(`Remove “${v.name}”?`, { ok: 'Remove', danger: true })) { await api.deleteAudio(v.id); onAudioChanged(); } }}>{Icon.trash({ size: 15 })}</button>}
                </div>
                {canEdit && on && <button className="btn sm" onClick={() => setSyncing(syncing === v.id ? null : v.id)} aria-expanded={syncing === v.id}>Adjust sync</button>}
                {syncing === v.id && <SyncTools asset={v} api={at} audioMs={audioMs} aiReady={false} onSaved={onAudioChanged} recordingMode={on} />}
              </div>
            );
          })}
          <p className="faint" style={{ margin: 0, fontSize: 12 }}>Videos play from YouTube in the floating player. Speed follows the tab (0.25x–2x); pitch shift and the metronome don’t apply.</p>
        </div>
      )}
      {canEdit && fromSongsterr && !videos.some((v) => v.videoSource === 'songsterr') && (
        <button className="btn sm" onClick={findSongsterr} disabled={busy}>{busy ? <span className="spinner" /> : null} Find Songsterr’s synced videos</button>
      )}
      {originals.map((a) => (
        <div key={a.id} className="asset">
          <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
            <div style={{ minWidth: 0 }}>
              <div className="nm" title={a.name}>{a.name}</div>
              <div className="faint" style={{ fontSize: 12 }}>
                {a.durationMs ? formatTime(a.durationMs) : '—'} · {a.syncPoints.length ? `synced (${a.syncPoints.length} points)` : a.offsetMs ? `offset ${a.offsetMs} ms` : 'not synced'}
              </div>
            </div>
            {canEdit && <button className="iconbtn" aria-label={`Remove ${a.name}`} onClick={async () => { if (await askConfirm(`Remove “${a.name}”?`, { body: 'Its stems and sync points are removed too.', ok: 'Remove', danger: true })) { await api.deleteAudio(a.id); onAudioChanged(); } }}>{Icon.trash({ size: 15 })}</button>}
          </div>
          {stemsOf(a.id).length > 0 && <div className="chips">{stemsOf(a.id).map((s) => <span key={s.id} className="badge">{s.name}</span>)}</div>}
          {canEdit && (
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" disabled={!ai?.available || activeJobs.some((j) => j.audioId === a.id)}
                title={ai?.available ? `Split into stems on ${ai.device?.toUpperCase()}` : ai?.reason ?? 'The AI tools are not set up'}
                onClick={async () => { try { await api.separate(a.id); refresh(); } catch (e) { toast((e as Error).message); } }}>
                {stemsOf(a.id).length ? 'Separate again' : 'Separate instruments'}
              </button>
              <button className="btn sm" onClick={() => setSyncing(syncing === a.id ? null : a.id)} aria-expanded={syncing === a.id}>Sync to tab</button>
              <a className="btn sm" href={`#/ai?audio=${a.id}`} title="Make a new tab from this recording">AI tab</a>
            </div>
          )}
          {syncing === a.id && <SyncTools asset={a} api={at} audioMs={audioMs} aiReady={!!ai?.available} onSaved={() => { onAudioChanged(); refresh(); }} recordingMode={playSource === 'recording'} />}
        </div>
      ))}
      {!ai?.available && originals.length > 0 && canEdit && <p className="faint" style={{ margin: 0, fontSize: 12 }}>{ai?.reason ?? 'Checking the AI tools…'} Stem separation and auto-sync need them; manual sync works without.</p>}
      {activeJobs.length > 0 && <div style={{ display: 'grid', gap: 8 }}>{activeJobs.map((j) => <JobRow key={j.id} j={j} onCancel={() => api.cancelJob(j.id).then(refresh)} />)}</div>}
      {jobs.filter((j) => j.state === 'failed').slice(0, 2).map((j) => <JobRow key={j.id} j={j} />)}
      {canEdit && (
        <>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? <span className="spinner" /> : Icon.upload({ size: 14 })} Add a recording</button>
            <input ref={fileRef} type="file" hidden accept=".flac,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus,.webm,audio/*" onChange={(e) => { upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
          </div>
          <form className="row" style={{ gap: 6, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void addVideo(); }}>
            <input type="text" id="yt-url" className="grow" placeholder="YouTube link" value={yt} onChange={(e) => setYt(e.target.value)} aria-label="YouTube link" style={{ minWidth: 140 }} />
            <button className="btn sm primary" disabled={!yt.trim()} title="Play the video in Fretforge, synced to the tab">Add video</button>
            <button type="button" className="btn sm" disabled={!yt.trim()} title="Download the audio as a recording (for stems and the mixer)"
              onClick={async () => { try { await api.youtube(songId, yt.trim()); setYt(''); refresh(); toast('Getting the audio…'); } catch (err) { if ((err as ApiError).code === 'ff-ytdlp-missing') setYtCheck((n) => n + 1); else toast((err as Error).message); } }}>Get audio</button>
          </form>
          {(yt.trim() || ytCheck > 0) && <YtdlpInstall recheck={ytCheck} />}
        </>
      )}
      {!audio.length && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Add a YouTube video or the original recording to play along with it. Recordings can be split into instruments with the AI tools.</p>}
    </div>
  );
}

function SyncTools({ asset, api: at, audioMs, aiReady, onSaved, recordingMode }: {
  asset: AudioAsset; api: alphaTab.AlphaTabApi | null; audioMs: () => number; aiReady: boolean; onSaved: () => void; recordingMode: boolean;
}) {
  const { toast } = useApp();
  const [offset, setOffset] = useState(asset.offsetMs);
  const [taps, setTaps] = useState<number[] | null>(null);
  const [startBar, setStartBar] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);

  const saveOffset = async (ms: number) => {
    setOffset(ms);
    try { await api.patchAudio(asset.id, { offsetMs: ms, syncPoints: [] }); onSaved(); } catch (e) { toast((e as Error).message); }
  };

  const tap = () => setTaps((t) => (t ? [...t, audioMs()] : t));
  useEffect(() => {
    if (!taps) return;
    const on = (e: KeyboardEvent) => { if (e.key === 'k' || e.key === 'K') { e.preventDefault(); e.stopPropagation(); tap(); } };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  });

  const saveTaps = async () => {
    if (!at || !taps || taps.length < 2) return;
    const tl = new Timeline(at);
    const first = tl.bars.findIndex((b) => b.index === startBar - 1);
    if (first < 0) return toast('That bar doesn’t exist.');
    const points: SyncPoint[] = taps.map((ms, i) => tl.bars[first + i]).map((b, i) => (b ? { bar: b.index, occurrence: b.occurrence, ms: taps[i] } : null)).filter((x): x is SyncPoint => !!x);
    try { await api.patchAudio(asset.id, { syncPoints: points }); setTaps(null); onSaved(); toast(`Saved ${points.length} sync points`); } catch (e) { toast((e as Error).message); }
  };

  const autoSync = async () => {
    if (!at?.score) return;
    setBusy('Rendering the tab…');
    try {
      const opts = new alphaTab.synth.AudioExportOptions();
      opts.sampleRate = 22050;
      opts.metronomeVolume = 0;
      opts.soundFonts = [new Uint8Array(await (await fetch('/soundfont/sonivox.sf2')).arrayBuffer())];
      const ex = await at.exportAudio(opts);
      const parts: Float32Array[] = [];
      for (;;) {
        const c = await ex.render(10000);
        if (!c) break;
        const mono = new Float32Array(c.samples.length >> 1);
        for (let i = 0; i < mono.length; i++) mono[i] = (c.samples[2 * i] + c.samples[2 * i + 1]) * 0.5;
        parts.push(mono);
      }
      (ex as unknown as { destroy?: () => void }).destroy?.();
      const len = parts.reduce((n, p) => n + p.length, 0);
      const all = new Float32Array(len);
      let o = 0;
      for (const p of parts) { all.set(p, o); o += p.length; }
      const tl = new Timeline(at);
      setBusy('Uploading…');
      await api.align(asset.id, new Blob([encodeWav([all], 22050) as BlobPart], { type: 'audio/wav' }), tl.bars.map((b) => ({ bar: b.index, occurrence: b.occurrence, ms: b.startMs })));
      toast('Auto-sync started. It runs in the background.');
      onSaved();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="synctools">
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm primary" onClick={autoSync} disabled={!aiReady || !!busy} title={aiReady ? 'Match the recording to a render of the tab' : 'Needs the AI tools'}>{busy ? <><span className="spinner" /> {busy}</> : 'Auto-sync'}</button>
        {asset.syncPoints.length > 0 && <button className="btn sm" onClick={async () => { await api.patchAudio(asset.id, { syncPoints: [] }); onSaved(); }}>Clear sync points</button>}
      </div>
      <div className="field">
        <span>Offset (ms) — when the tab’s first bar starts in the recording</span>
        <div className="row" style={{ gap: 4 }}>
          <button className="tbtn" onClick={() => saveOffset(offset - 100)}>−100</button>
          <button className="tbtn" onClick={() => saveOffset(offset - 10)}>−10</button>
          <input type="number" id="sync-offset" value={offset} onChange={(e) => setOffset(Number(e.target.value) || 0)} onBlur={() => saveOffset(offset)} style={{ width: 90 }} />
          <button className="tbtn" onClick={() => saveOffset(offset + 10)}>+10</button>
          <button className="tbtn" onClick={() => saveOffset(offset + 100)}>+100</button>
        </div>
      </div>
      {!taps ? (
        <button className="btn sm" onClick={() => setTaps([])} disabled={!recordingMode} title={recordingMode ? '' : 'Switch to “Recording” first'}>Tap along to sync…</button>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="muted" style={{ fontSize: 13 }}>Play the recording and press <span className="kbd">K</span> (or the button) on beat one of every bar, starting at bar</span>
          <div className="row" style={{ gap: 6 }}>
            <input type="number" id="sync-start" min={1} value={startBar} onChange={(e) => setStartBar(Math.max(1, Number(e.target.value) || 1))} style={{ width: 70 }} />
            <button className="btn sm primary" onClick={tap}>Tap ({taps.length})</button>
            <button className="btn sm" onClick={saveTaps} disabled={taps.length < 2}>Save</button>
            <button className="btn sm ghost" onClick={() => setTaps(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// "AI tab": a recording or a YouTube link becomes a multi-track tab (like Songsterr's AI).
// Separation, beats, notes and lyrics run in the local AI worker; the result opens in the editor.
import { useEffect, useRef, useState } from 'react';
import { AI_INSTRUMENTS, TUNING_CATALOG, type AiInstrument, type Job, type TranscribeOptions } from '@fretforge/shared';
import { api } from '../api';
import { go, useApp } from '../lib/app';
import { JobRow, useJobs } from '../player/AudioPanel';
import { Icon } from './icons';

const SIGS: [string, [number, number] | null][] = [['Auto', null], ['4/4', [4, 4]], ['3/4', [3, 4]], ['2/4', [2, 4]], ['5/4', [5, 4]], ['6/8', [6, 8]], ['12/8', [12, 8]], ['7/8', [7, 8]]];
const GUITAR_TUNINGS = TUNING_CATALOG.filter((t) => ['guitar6', 'guitar7', 'guitar8', 'guitar9'].includes(t.family));
const BASS_TUNINGS = TUNING_CATALOG.filter((t) => t.family.startsWith('bass'));

export function AiTabView({ audioId }: { audioId?: string }) {
  const { toast, user } = useApp();
  const { jobs, ai, refresh } = useJobs();
  const [source, setSource] = useState<'file' | 'youtube'>(audioId ? 'file' : 'file');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [inst, setInst] = useState<AiInstrument[]>(['guitar', 'bass', 'drums', 'vocals']);
  const [gt, setGt] = useState('Standard');
  const [capo, setCapo] = useState(0);
  const [bt, setBt] = useState('Bass Standard');
  const [sig, setSig] = useState('Auto');
  const [pickup, setPickup] = useState<string>('auto');
  const [bpm, setBpm] = useState('');
  const [feel, setFeel] = useState<'auto' | 'straight' | 'triplet'>('auto');
  const [lyrics, setLyrics] = useState(true);
  const [priv, setPriv] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const aiJobs = jobs.filter((j) => j.kind === 'transcribe' && (mine.includes(j.id) || j.createdBy === user?.id)).slice(0, 8);
  // jump to a finished tab the user just started
  const opened = useRef(new Set<string>());
  useEffect(() => {
    for (const j of aiJobs) if (j.state === 'done' && mine.includes(j.id) && j.songId && !opened.current.has(j.id)) {
      opened.current.add(j.id);
      toast('Your AI tab is ready');
    }
  }, [aiJobs, mine, toast]);

  const options = (): TranscribeOptions => ({
    instruments: inst,
    title: title.trim() || undefined, artist: artist.trim() || undefined,
    guitarTuning: GUITAR_TUNINGS.find((t) => t.name === gt)?.notes, guitarCapo: capo,
    bassTuning: BASS_TUNINGS.find((t) => t.name === bt)?.notes,
    timeSignature: SIGS.find(([k]) => k === sig)?.[1] ?? null,
    pickupBeats: pickup === 'auto' ? null : Number(pickup),
    bpm: bpm ? Number(bpm) : null, feel, lyrics, private: priv,
  });

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inst.length) return toast('Choose at least one instrument.');
    setBusy(true);
    try {
      let j: Job;
      if (audioId) j = await api.transcribe({ audioId, options: options() });
      else if (source === 'youtube') j = await api.transcribe({ url: url.trim(), options: options() });
      else {
        if (!file) { toast('Choose a recording.'); setBusy(false); return; }
        j = await api.transcribeUpload(file, options());
      }
      setMine((m) => [j.id, ...m]);
      refresh();
      toast('Transcribing in the background. You can leave this page.');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (i: AiInstrument) => setInst((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]));

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="section-h"><h2>AI tab</h2><span className="muted">Turn a recording into a tab you can play and edit</span></div>
      {ai && !ai.available && ai.reason !== 'Not checked yet' && (
        <div className="error">{ai.reason ?? 'The AI tools aren’t set up.'} <a href="#/settings">Set up the AI tools</a></div>
      )}
      <form className="card setcard aiform" onSubmit={start}>
        {!audioId && (
          <div className="chips" role="radiogroup" aria-label="Source">
            <button type="button" className="chip" role="radio" aria-checked={source === 'file'} aria-pressed={source === 'file'} onClick={() => setSource('file')}>{Icon.upload({ size: 14 })} Recording</button>
            <button type="button" className="chip" role="radio" aria-checked={source === 'youtube'} aria-pressed={source === 'youtube'} onClick={() => setSource('youtube')}>YouTube link</button>
          </div>
        )}
        {audioId ? <p className="muted" style={{ margin: 0 }}>Transcribing the song’s recording.</p>
          : source === 'file' ? (
            <div className="row">
              <button type="button" className="btn" onClick={() => fileRef.current?.click()}>{Icon.upload({ size: 15 })} {file ? 'Change file' : 'Choose a recording'}</button>
              <span className="muted" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{file?.name ?? 'FLAC, WAV, MP3, M4A, OGG'}</span>
              <input ref={fileRef} type="file" hidden accept=".flac,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus,.webm,audio/*" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, '')); e.target.value = ''; }} />
            </div>
          ) : (
            <label className="field"><span>YouTube link</span><input type="url" id="ai-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" /></label>
          )}
        <div className="row">
          <label className="field grow"><span>Title</span><input type="text" id="ai-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="From the file or video" /></label>
          <label className="field grow"><span>Artist</span><input type="text" id="ai-artist" value={artist} onChange={(e) => setArtist(e.target.value)} /></label>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend><span>Instruments</span></legend>
          <div className="chips">
            {AI_INSTRUMENTS.map((i) => <button type="button" key={i.id} className="chip" aria-pressed={inst.includes(i.id)} onClick={() => toggle(i.id)}>{i.label}</button>)}
          </div>
        </fieldset>
        {(inst.includes('guitar') || inst.includes('bass')) && (
          <div className="row">
            {inst.includes('guitar') && (
              <>
                <label className="field"><span>Guitar tuning</span>
                  <select id="ai-gt" value={gt} onChange={(e) => setGt(e.target.value)}>
                    {['guitar6', 'guitar7', 'guitar8', 'guitar9'].map((f) => (
                      <optgroup key={f} label={`${f.slice(6)}-string`}>{GUITAR_TUNINGS.filter((t) => t.family === f).map((t) => <option key={t.name}>{t.name}</option>)}</optgroup>
                    ))}
                  </select>
                </label>
                <label className="field"><span>Capo</span>
                  <select id="ai-capo" value={capo} onChange={(e) => setCapo(Number(e.target.value))}>{Array.from({ length: 13 }, (_, i) => <option key={i} value={i}>{i ? `Fret ${i}` : 'None'}</option>)}</select>
                </label>
              </>
            )}
            {inst.includes('bass') && (
              <label className="field"><span>Bass tuning</span>
                <select id="ai-bt" value={bt} onChange={(e) => setBt(e.target.value)}>
                  {['bass4', 'bass5', 'bass6'].map((f) => (
                    <optgroup key={f} label={`${f.slice(4)}-string`}>{BASS_TUNINGS.filter((t) => t.family === f).map((t) => <option key={t.name}>{t.name}</option>)}</optgroup>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        <details className="aiadv">
          <summary>First bar and rhythm <span className="faint">(automatic unless you set them)</span></summary>
          <div className="row">
            <label className="field"><span>Time signature</span>
              <select id="ai-sig" value={sig} onChange={(e) => setSig(e.target.value)}>{SIGS.map(([k]) => <option key={k}>{k}</option>)}</select>
            </label>
            <label className="field"><span>Pickup beats</span>
              <select id="ai-pickup" value={pickup} onChange={(e) => setPickup(e.target.value)}>
                <option value="auto">Auto</option>{Array.from({ length: 8 }, (_, i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </label>
            <label className="field"><span>First-bar BPM</span>
              <input type="number" id="ai-bpm" min={30} max={300} value={bpm} placeholder="Auto" onChange={(e) => setBpm(e.target.value)} style={{ width: 100 }} />
            </label>
            <label className="field"><span>Feel</span>
              <select id="ai-feel" value={feel} onChange={(e) => setFeel(e.target.value as never)}>
                <option value="auto">Auto</option><option value="straight">Straight</option><option value="triplet">Triplet (swing)</option>
              </select>
            </label>
          </div>
        </details>
        <label className="row"><input type="checkbox" id="ai-lyrics" checked={lyrics} onChange={(e) => setLyrics(e.target.checked)} disabled={!inst.includes('vocals')} /> Transcribe lyrics (needs Whisper)</label>
        <label className="row"><input type="checkbox" id="ai-private" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Keep it private until I share it</label>
        <div className="row">
          <button className="btn primary" disabled={busy || !ai?.available}>{busy ? <span className="spinner" /> : null} Make the tab</button>
          <span className="faint" style={{ fontSize: 13 }}>Takes a few minutes on a GPU, longer on a CPU. Pitches, rhythm and fingering are a starting point: review it in the editor.</span>
        </div>
      </form>
      {aiJobs.length > 0 && (
        <section className="card setcard">
          <h3>Your AI tabs</h3>
          {aiJobs.map((j) => (
            <div key={j.id} style={{ display: 'grid', gap: 6 }}>
              <JobRow j={j} onCancel={() => api.cancelJob(j.id).then(refresh)} />
              {j.state === 'done' && j.songId && (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm primary" onClick={() => go(`/song/${j.songId}?edit=1`)}>Review in the editor</button>
                  <button className="btn sm" onClick={() => go(`/song/${j.songId}`)}>Play</button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

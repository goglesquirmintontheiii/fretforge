import { useCallback, useEffect, useRef, useState } from 'react';
import type { Instrument, SongRecord } from '@fretforge/shared';
import { INSTRUMENT_LABELS } from '@fretforge/shared';
import { api } from '../api';
import { useApp, useDebounced } from '../lib/app';
import { Icon, InstrumentIcon } from './icons';
import { SongRow } from './SongRow';

const INSTRUMENTS: (Instrument | 'all')[] = ['all', 'guitar', 'bass', 'drums', 'keys', 'vocals'];
const SORTS = [['artist', 'Artist'], ['title', 'Title'], ['added', 'Recently added'], ['recent', 'Recently played'], ['played', 'Most played']] as const;

export function InstrumentFilter() {
  const { prefs, setPrefs } = useApp();
  return (
    <div className="chips" role="group" aria-label="Instrument">
      {INSTRUMENTS.map((i) => (
        <button key={i} className="chip" aria-pressed={prefs.instrument === i} onClick={() => setPrefs({ instrument: i })}>
          {i !== 'all' && <InstrumentIcon i={i} size={14} />}{i === 'all' ? 'All instruments' : INSTRUMENT_LABELS[i]}
        </button>
      ))}
    </div>
  );
}

export function LibraryView() {
  const { prefs, toast } = useApp();
  const [songs, setSongs] = useState<SongRecord[] | null>(null);
  const [recent, setRecent] = useState<SongRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<string>(() => { try { return localStorage.getItem('ff-sort') || 'artist'; } catch { return 'artist'; } });
  const [favOnly, setFavOnly] = useState(false);
  const [importing, setImporting] = useState(false);
  const [drag, setDrag] = useState(false);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.libraryStatus>> | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const q = useDebounced(filter, 150);

  const load = useCallback(() => {
    api.songs({ q, instrument: prefs.instrument, sort: q ? undefined : sort, favorites: favOnly })
      .then((r) => { setSongs(r.songs); setTotal(r.total); })
      .catch((e) => toast(e.message));
  }, [q, prefs.instrument, sort, favOnly, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.history().then((r) => setRecent(r.songs.slice(0, 6))).catch(() => {}); }, []);
  useEffect(() => {
    let alive = true;
    const poll = () => api.libraryStatus().then((s) => {
      if (!alive) return;
      setStatus((prev) => {
        if (prev && (prev.songCount !== s.songCount || (prev.scanning && !s.scanning))) load();
        return s;
      });
    }).catch(() => {});
    poll();
    const t = setInterval(poll, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [load]);
  useEffect(() => { try { localStorage.setItem('ff-sort', sort); } catch { /* private mode */ } }, [sort]);

  const doImport = async (files: File[]) => {
    if (!files.length) return;
    setImporting(true);
    try {
      const r = await api.importFiles(files);
      const n = r.imported.length;
      toast(n ? `Imported ${n} song${n === 1 ? '' : 's'}${r.errors.length ? `, ${r.errors.length} skipped` : ''}` : r.errors[0]?.message ?? 'Nothing imported');
      load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const toggleFav = async (s: SongRecord) => {
    const updated = await api.patchSong(s.id, { favorite: !s.favorite });
    setSongs((list) => list?.map((x) => (x.id === s.id ? updated : x)) ?? null);
  };

  return (
    <div className="page"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); doImport([...e.dataTransfer.files]); }}>
      {recent.length > 0 && !q && (
        <section className="grid" style={{ display: 'grid', gap: 10 }}>
          <div className="section-h"><h2>Pick up where you left off</h2></div>
          <div className="card songlist">
            {recent.map((s) => <SongRow key={s.id} song={s} preferred={prefs.instrument} />)}
          </div>
        </section>
      )}

      <section style={{ display: 'grid', gap: 12 }}>
        <div className="section-h">
          <h2>Library</h2>
          <span className="muted">{total} song{total === 1 ? '' : 's'}{status?.scanning ? ' · scanning your folder…' : ''}</span>
          <span className="grow" />
          <button className="btn sm" onClick={() => fileInput.current?.click()} disabled={importing}>
            {importing ? <span className="spinner" /> : Icon.upload({ size: 15 })} Import files
          </button>
          <input ref={fileInput} type="file" multiple hidden accept=".gp,.gp3,.gp4,.gp5,.gpx,.musicxml,.mxl,.xml,.mid,.midi,.capx"
            onChange={(e) => { doImport([...(e.target.files ?? [])]); e.target.value = ''; }} />
        </div>
        <InstrumentFilter />
        <div className="row">
          <input type="search" id="library-filter" className="grow" placeholder="Filter by title, artist, album or tuning" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter library" />
          <select id="library-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort" disabled={!!q}>
            {SORTS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
          <button className="chip" aria-pressed={favOnly} onClick={() => setFavOnly(!favOnly)}>{Icon.star({ size: 14 })} Favorites</button>
        </div>
        {drag && <div className="dropzone">Drop Guitar Pro, MusicXML or MIDI files to import them</div>}
        {songs === null ? <div className="empty"><span className="spinner" /></div>
          : songs.length === 0 ? (
            <div className="empty">
              <b>{total ? 'Nothing matches' : 'Your library is empty'}</b>
              {total ? 'Try another filter or instrument.' : <>Drop Guitar Pro files here, put them in <span className="mono">{status?.dir}</span>, or search Songsterr and Ultimate Guitar from the bar above.</>}
            </div>
          ) : (
            <div className="card songlist">
              {songs.map((s) => <SongRow key={s.id} song={s} preferred={prefs.instrument} onFavorite={toggleFav} />)}
            </div>
          )}
        {status && status.errors.length > 0 && (
          <div className="card" style={{ padding: '10px 14px' }}>
            <button className="btn ghost sm" onClick={() => setShowErrors(!showErrors)}>
              {status.errors.length} file{status.errors.length === 1 ? '' : 's'} in your folder couldn’t be imported {showErrors ? '▴' : '▾'}
            </button>
            {showErrors && (
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, display: 'grid', gap: 4 }}>
                {status.errors.map((e) => <li key={e.path}><span className="mono" style={{ fontSize: 12 }}>{e.path}</span><br /><span className="muted">{e.message}</span></li>)}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Instrument, Playlist, SongRecord } from '@fretforge/shared';
import { GUITAR_TONES, INSTRUMENT_LABELS, STRING_FAMILIES, TUNING_CATALOG } from '@fretforge/shared';
import { api, type Facet, type LibraryFacets, type SongQuery } from '../api';
import { go, useApp, useDebounced } from '../lib/app';
import { Icon, InstrumentIcon } from './icons';
import { SongRow } from './SongRow';
import { pinOffline } from '../lib/offline';
import { askConfirm, askText } from '../lib/dialog';

const INSTRUMENTS: (Instrument | 'all')[] = ['all', 'guitar', 'bass', 'drums', 'keys', 'vocals'];
const SORTS = [['artist', 'Artist'], ['title', 'Title'], ['added', 'Recently added'], ['recent', 'Recently played'], ['played', 'Most played']] as const;
const SOURCES = [['', 'All sources'], ['local', 'My files'], ['songsterr', 'Songsterr'], ['ultimate-guitar', 'Ultimate Guitar'], ['created', 'Made here'], ['demo', 'Demos']] as const;

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

let playlistCache: Playlist[] = [];

export function usePlaylists() {
  const [list, setList] = useState<Playlist[]>(playlistCache);
  const load = useCallback(() => api.playlists().then((r) => { playlistCache = r.playlists; setList(r.playlists); }).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  return { playlists: list, reload: load };
}

/** “Add to playlist” menu for one song. */
export function PlaylistMenu({ song, onClose }: { song: SongRecord; onClose: () => void }) {
  const { toast, user } = useApp();
  const { playlists, reload } = usePlaylists();
  const [name, setName] = useState('');
  const mine = playlists.filter((p) => p.ownerId === user?.id || user?.role === 'owner');
  return (
    <div className="popover" style={{ top: 'calc(100% + 4px)', bottom: 'auto', left: 'auto', right: 0, minWidth: 240 }} onClick={(e) => e.stopPropagation()}>
      <b style={{ fontSize: 13 }}>Add to playlist</b>
      {mine.map((p) => {
        const inIt = p.songIds.includes(song.id);
        return (
          <button key={p.id} className="btn sm ghost" style={{ justifyContent: 'flex-start' }} onClick={async (e) => {
            e.preventDefault();
            await api.patchPlaylist(p.id, inIt ? { remove: [song.id] } : { add: [song.id] });
            toast(inIt ? `Removed from “${p.name}”` : `Added to “${p.name}”`);
            reload();
          }}>{inIt ? '✓' : '+'} {p.name}</button>
        );
      })}
      <form className="row" style={{ gap: 6, flexWrap: 'nowrap' }} onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; await api.createPlaylist(name.trim(), [song.id]); toast(`Created “${name.trim()}”`); setName(''); reload(); onClose(); }}>
        <input type="text" className="grow" placeholder="New playlist" value={name} onChange={(e) => setName(e.target.value)} aria-label="New playlist name" />
        <button className="btn sm" disabled={!name.trim()}>Create</button>
      </form>
    </div>
  );
}

export function LibraryView({ playlist, view }: { playlist?: string; view?: 'favorites' | 'mine' | 'offline' } = {}) {
  const { prefs, toast, user } = useApp();
  const canEdit = user?.role !== 'viewer';
  const [songs, setSongs] = useState<SongRecord[] | null>(null);
  const [recent, setRecent] = useState<SongRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<string>(() => { try { return localStorage.getItem('ff-sort') || 'artist'; } catch { return 'artist'; } });
  const [tuning, setTuning] = useState('');
  const [source, setSource] = useState('');
  const [withAudio, setWithAudio] = useState(false);
  const [family, setFamily] = useState('');
  const [body, setBody] = useState('');
  const [tone, setTone] = useState('');
  const [facets, setFacets] = useState<LibraryFacets>({ tunings: [], families: [], bodies: [], tones: [] });
  const [importing, setImporting] = useState(false);
  const [drag, setDrag] = useState(false);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.libraryStatus>> | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const { playlists, reload: reloadPlaylists } = usePlaylists();
  const fileInput = useRef<HTMLInputElement>(null);
  const q = useDebounced(filter, 150);
  const pl = playlist ? playlists.find((p) => p.id === playlist) : undefined;

  const load = useCallback(() => {
    const query: SongQuery = {
      q, instrument: prefs.instrument, sort: q || playlist ? undefined : sort, favorites: view === 'favorites', mine: view === 'mine',
      offline: view === 'offline', tuning: tuning || undefined, source: source || undefined, audio: withAudio, playlist,
      family: family || undefined, body: body || undefined, tone: tone || undefined,
    };
    api.songs(query).then((r) => { setSongs(r.songs); setTotal(r.total); }).catch((e) => toast(e.message));
  }, [q, prefs.instrument, sort, view, tuning, family, body, tone, source, withAudio, playlist, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.history().then((r) => setRecent(r.songs.slice(0, 6))).catch(() => {}); api.facets().then(setFacets).catch(() => {}); }, []);
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
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuFor]);

  const doImport = async (files: File[]) => {
    if (!files.length || !canEdit) return;
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

  const move = async (id: string, delta: number) => {
    if (!pl) return;
    const ids = [...pl.songIds];
    const i = ids.indexOf(id), j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.patchPlaylist(pl.id, { songIds: ids });
    reloadPlaylists();
    setSongs((list) => { if (!list) return list; const l = [...list]; const a = l.findIndex((x) => x.id === id); const b = a + delta; if (b < 0 || b >= l.length) return l; [l[a], l[b]] = [l[b], l[a]]; return l; });
  };

  const title = pl ? pl.name : view === 'favorites' ? 'Favorites' : view === 'mine' ? 'My tabs' : view === 'offline' ? 'Available offline' : 'Library';
  const filtered = !!(tuning || family || body || tone || source || withAudio);

  return (
    <div className="page"
      onDragOver={(e) => { if (canEdit && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); doImport([...e.dataTransfer.files]); }}>
      <nav className="libnav" aria-label="Collections">
        <a href="#/" aria-current={!playlist && !view ? 'page' : undefined}>All songs</a>
        <a href="#/favorites" aria-current={view === 'favorites' ? 'page' : undefined}>{Icon.star({ size: 14 })} Favorites</a>
        <a href="#/mine" aria-current={view === 'mine' ? 'page' : undefined}>{Icon.edit({ size: 14 })} My tabs</a>
        <a href="#/offline" aria-current={view === 'offline' ? 'page' : undefined}>{Icon.offline({ size: 14 })} Offline</a>
        {playlists.map((p) => <a key={p.id} href={`#/playlist/${p.id}`} aria-current={playlist === p.id ? 'page' : undefined}>{Icon.list({ size: 14 })} {p.name}{p.shared ? ' ·' : ''}</a>)}
        <button className="libnav-add" onClick={async () => {
          const name = await askText('New playlist', { label: 'Name', ok: 'Create' });
          if (!name?.trim()) return;
          const p = await api.createPlaylist(name.trim());
          await reloadPlaylists();
          go(`/playlist/${p.id}`);
        }}>{Icon.plus({ size: 14 })} Playlist</button>
      </nav>

      {recent.length > 0 && !q && !playlist && !view && !filtered && (
        <section style={{ display: 'grid', gap: 10 }}>
          <div className="section-h"><h2>Pick up where you left off</h2></div>
          <div className="card songlist">
            {recent.map((s) => <SongRow key={s.id} song={s} preferred={prefs.instrument} />)}
          </div>
        </section>
      )}

      <section style={{ display: 'grid', gap: 12 }}>
        <div className="section-h">
          <h2>{title}</h2>
          <span className="muted">{pl ? `${pl.songIds.length} song${pl.songIds.length === 1 ? '' : 's'}${pl.ownerName && pl.ownerId !== user?.id ? ` · by ${pl.ownerName}` : ''}` : `${songs?.length ?? 0} of ${total} song${total === 1 ? '' : 's'}`}{status?.scanning ? ' · scanning your folder…' : ''}</span>
          <span className="grow" />
          {pl && (pl.ownerId === user?.id || user?.role === 'owner') && (
            <>
              <label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={pl.shared} onChange={async (e) => { await api.patchPlaylist(pl.id, { shared: e.target.checked }); reloadPlaylists(); }} /> Shared with everyone</label>
              <button className="btn sm" onClick={async () => { const n = await askText('Rename playlist', { value: pl.name, ok: 'Rename' }); if (n?.trim()) { await api.patchPlaylist(pl.id, { name: n.trim() }); reloadPlaylists(); } }}>Rename</button>
              <button className="btn sm" title="Queue stem separation for every song with a recording, to run in the idle window" onClick={async () => { try { const r = await api.separatePlaylist(pl.id); toast(r.added.length ? `Queued ${r.added.length} song${r.added.length === 1 ? '' : 's'} for tonight` : 'Nothing to separate: no recordings without stems'); } catch (e) { toast((e as Error).message); } }}>Separate overnight</button>
              <button className="btn sm danger" onClick={async () => { if (await askConfirm(`Delete “${pl.name}”?`, { body: 'The songs stay in the library.', ok: 'Delete', danger: true })) { await api.deletePlaylist(pl.id); reloadPlaylists(); go('/'); } }}>{Icon.trash({ size: 14 })}</button>
            </>
          )}
          {!pl && canEdit && (
            <>
              <a className="btn sm" href="#/new">{Icon.plus({ size: 15 })} New tab</a>
              <a className="btn sm" href="#/ai" title="Make a tab from a recording or a YouTube link">AI tab</a>
              <button className="btn sm" onClick={() => fileInput.current?.click()} disabled={importing}>
                {importing ? <span className="spinner" /> : Icon.upload({ size: 15 })} Import files
              </button>
            </>
          )}
          <input ref={fileInput} type="file" multiple hidden accept=".gp,.gp3,.gp4,.gp5,.gpx,.musicxml,.mxl,.xml,.mid,.midi,.capx"
            onChange={(e) => { doImport([...(e.target.files ?? [])]); e.target.value = ''; }} />
        </div>
        <InstrumentFilter />
        <div className="row">
          <input type="search" id="library-filter" className="grow" placeholder="Filter by title, artist, album or tuning" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter library" />
          <select id="library-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort" disabled={!!q || !!playlist}>
            {SORTS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
        </div>
        <div className="row filters" role="group" aria-label="Filters">
          <TrackFilters facets={facets} family={family} tuning={tuning} body={body} tone={tone}
            onChange={(f) => { if (f.family !== undefined) setFamily(f.family); if (f.tuning !== undefined) setTuning(f.tuning); if (f.body !== undefined) setBody(f.body); if (f.tone !== undefined) setTone(f.tone); }} />
          <select id="library-source" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
            {SOURCES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
          <button className="chip" aria-pressed={withAudio} onClick={() => setWithAudio(!withAudio)}>{Icon.mic({ size: 14 })} With recordings</button>
        </div>
        {drag && <div className="dropzone">Drop Guitar Pro, MusicXML or MIDI files to import them</div>}
        {songs === null ? <div className="empty"><span className="spinner" /></div>
          : songs.length === 0 ? (
            <div className="empty">
              <b>{pl ? 'This playlist is empty' : view === 'favorites' ? 'No favorites yet' : view === 'mine' ? 'You haven’t made or edited a tab yet' : view === 'offline' ? 'Nothing is saved for offline use' : total ? 'Nothing matches' : 'Your library is empty'}</b>
              {pl ? 'Add songs with the ⋯ button on any song.' : view === 'offline' ? 'Open a song and choose “Keep offline” in its ⋯ menu.' : view ? '' : total ? 'Try another filter or instrument.' : <>Drop Guitar Pro files here, put them in <span className="mono">{status?.dir}</span>, or search Songsterr and Ultimate Guitar from the bar above.</>}
            </div>
          ) : (
            <div className="card songlist">
              {songs.map((s, i) => (
                <div key={s.id} className="songwrap">
                  <SongRow song={s} preferred={prefs.instrument} onFavorite={toggleFav} />
                  <div className="songtools">
                    {pl && (pl.ownerId === user?.id || user?.role === 'owner') && (
                      <>
                        <button className="iconbtn" aria-label="Move up" disabled={i === 0} onClick={() => move(s.id, -1)}>▲</button>
                        <button className="iconbtn" aria-label="Move down" disabled={i === songs.length - 1} onClick={() => move(s.id, 1)}>▼</button>
                      </>
                    )}
                    <span className="popwrap">
                      <button className="iconbtn" aria-label={`More for ${s.title}`} onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === s.id ? null : s.id); }}>⋯</button>
                      {menuFor === s.id && (
                        <div onClick={(e) => e.stopPropagation()}>
                          <PlaylistMenu song={s} onClose={() => setMenuFor(null)} />
                        </div>
                      )}
                    </span>
                    {view === 'offline' && <button className="iconbtn" aria-label="Remove from offline" onClick={async () => { await pinOffline(s, false); load(); }}>{Icon.close({ size: 14 })}</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        {status && status.errors.length > 0 && !playlist && !view && (
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

type FilterPatch = Partial<Record<'family' | 'tuning' | 'body' | 'tone', string>>;

/** strings, tuning, guitar type and tone: every common tuning is listed, with how many songs use it */
export function TrackFilters({ facets, family, tuning, body, tone, onChange }: { facets: LibraryFacets; family: string; tuning: string; body: string; tone: string; onChange: (p: FilterPatch) => void }) {
  const count = (list: Facet[], name: string) => list.find((f) => f.name === name)?.count ?? 0;
  const label = (name: string, n: number) => (n ? `${name} (${n})` : name);
  const fams = family ? STRING_FAMILIES.filter((f) => f.id === family) : STRING_FAMILIES;
  const tuningsFor = (fam: string) => {
    const known = TUNING_CATALOG.filter((t) => t.family === fam).map((t) => t.name);
    const extra = facets.tunings.filter((t) => t.family === fam && !known.includes(t.name)).map((t) => t.name);
    return [...known, ...extra];
  };
  return (
    <>
      <select id="library-strings" value={family} aria-label="Strings" onChange={(e) => {
        const f = e.target.value;
        // keep the tuning only if it belongs to the new string count
        onChange({ family: f, tuning: f && tuning && !tuningsFor(f).includes(tuning) ? '' : tuning });
      }}>
        <option value="">Any strings</option>
        <optgroup label="Guitar">{STRING_FAMILIES.filter((f) => f.instrument === 'guitar').map((f) => <option key={f.id} value={f.id}>{label(f.label, count(facets.families, f.id))}</option>)}</optgroup>
        <optgroup label="Bass">{STRING_FAMILIES.filter((f) => f.instrument === 'bass').map((f) => <option key={f.id} value={f.id}>{label(f.label, count(facets.families, f.id))}</option>)}</optgroup>
      </select>
      <select id="library-tuning" value={tuning} onChange={(e) => onChange({ tuning: e.target.value })} aria-label="Tuning">
        <option value="">Any tuning</option>
        {fams.map((f) => (
          <optgroup key={f.id} label={f.label}>
            {tuningsFor(f.id).map((name) => <option key={name} value={name}>{label(name, count(facets.tunings, name))}</option>)}
          </optgroup>
        ))}
        {!family && facets.tunings.some((t) => !t.family) && (
          <optgroup label="Other">{facets.tunings.filter((t) => !t.family).map((t) => <option key={t.name} value={t.name}>{label(t.name, t.count)}</option>)}</optgroup>
        )}
      </select>
      <select id="library-body" value={body} onChange={(e) => onChange({ body: e.target.value })} aria-label="Guitar type">
        <option value="">Any guitar</option>
        <option value="electric">{label('Electric', count(facets.bodies, 'electric'))}</option>
        <option value="acoustic">{label('Acoustic', count(facets.bodies, 'acoustic'))}</option>
        <option value="classical">{label('Classical (nylon)', count(facets.bodies, 'classical'))}</option>
      </select>
      <select id="library-tone" value={tone} onChange={(e) => onChange({ tone: e.target.value })} aria-label="Tone">
        <option value="">Any tone</option>
        {GUITAR_TONES.map((t) => <option key={t.id} value={t.id}>{label(t.label, count(facets.tones, t.id))}</option>)}
      </select>
    </>
  );
}

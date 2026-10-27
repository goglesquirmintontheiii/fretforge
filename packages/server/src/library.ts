import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import MiniSearch from 'minisearch';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Instrument, Revision, SongRecord, SongSource, TextTab } from '@fretforge/shared';
import { Store, contentHash, shortId } from './store';
import { ALL_EXTENSIONS, SCORE_EXTENSIONS, exportGp7, extOf, loadScore, summarizeScore, UnsupportedFormatError } from './score';
import type * as alphaTab from '@coderline/alphatab';

/** Formats the browser-side alphaTab can open directly. Everything else is converted to GP7. */
const DIRECT_EXTENSIONS = new Set(['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'musicxml', 'mxl', 'xml', 'capx']);

export interface ImportError { path: string; message: string; at: number }

export interface ListQuery {
  q?: string;
  instrument?: Instrument | 'all';
  sort?: 'recent' | 'title' | 'artist' | 'added' | 'played';
  favorites?: boolean;
  limit?: number;
  /** personal fields (favorites, recent) come from this user */
  userId: string;
  tuning?: string;
  source?: string;
  /** only songs with recordings/stems */
  withAudio?: boolean;
  /** only songs in this playlist (in playlist order) */
  ids?: string[];
  /** only tabs this user made or edited */
  mine?: boolean;
  /** only songs this user pinned for offline use */
  offline?: boolean;
}

/** Guess "Artist - Title" from a file name when the file has no metadata. */
export function titleFromFileName(path: string): { title: string; artist: string } {
  const name = basename(path, extname(path)).replace(/[_]+/g, ' ').trim();
  const m = /^(.+?)\s+-\s+(.+)$/.exec(name);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  const parent = basename(dirname(path));
  return { artist: parent && !/^(library|imported|tabs|music)$/i.test(parent) ? parent : '', title: name };
}

export class Library {
  private index: MiniSearch<{ id: string }> | null = null;
  private watcher: FSWatcher | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  readonly errors = new Map<string, ImportError>();
  scanning = false;
  watchedDir = '';

  constructor(readonly store: Store, readonly dataDir: string) {
    store.onChange(() => { this.index = null; });
  }

  // ------------------------------------------------------------ files

  absFile(song: SongRecord): string {
    return isAbsolute(song.file) ? song.file : join(this.dataDir, song.file);
  }

  readScoreBytes(song: SongRecord): Uint8Array {
    return readFileSync(this.absFile(song));
  }

  readText(song: SongRecord): TextTab {
    return JSON.parse(readFileSync(this.absFile(song), 'utf8'));
  }

  // ------------------------------------------------------------ import

  /** Build a song record from a parsed score. Converts formats the browser can't read to GP7. */
  private recordFromScore(opts: {
    id: string; score: alphaTab.model.Score; ext: string; source: SongSource; sourcePath?: string; hash: string; mtime?: number;
    fallback?: { title: string; artist: string }; warnings?: string[];
  }): SongRecord {
    const sum = summarizeScore(opts.score);
    let file: string;
    let ext = opts.ext;
    if (opts.sourcePath && DIRECT_EXTENSIONS.has(opts.ext)) {
      file = opts.sourcePath;
    } else {
      file = join('scores', `${opts.id}.gp`);
      writeFileSync(join(this.dataDir, file), exportGp7(opts.score));
      ext = 'gp';
    }
    const prev = this.store.song(opts.id);
    const now = Date.now();
    return {
      id: opts.id,
      title: sum.title || opts.fallback?.title || 'Untitled',
      artist: sum.artist || opts.fallback?.artist || '',
      album: sum.album,
      format: 'score',
      file,
      ext,
      source: opts.source,
      tracks: sum.tracks,
      instruments: sum.instruments,
      tempo: sum.tempo,
      bars: sum.bars,
      hasLyrics: sum.hasLyrics,
      hash: opts.hash,
      addedAt: prev?.addedAt ?? now,
      updatedAt: now,
      fileMtime: opts.mtime,
      warnings: opts.warnings?.length ? opts.warnings : undefined,
      ...(prev?.revision ? {
        // an edited revision is the default: keep showing it; the new file content becomes revision 0
        file: prev.file, ext: prev.ext, tracks: prev.tracks, instruments: prev.instruments, tempo: prev.tempo, bars: prev.bars,
        hasLyrics: prev.hasLyrics, revision: prev.revision, title: prev.title, artist: prev.artist,
      } : {}),
    };
  }

  /** Saves edited score bytes as a new revision and makes it the default. */
  saveRevision(song: SongRecord, bytes: Uint8Array, user: { id: string; name: string } | null, message: string): Revision {
    const score = loadScore(bytes, 'gp');
    const sum = summarizeScore(score);
    const revs = this.store.revisions(song.id);
    if (!revs.length) {
      // the file as imported becomes revision 0
      this.store.addRevision({
        rev: 0, songId: song.id, userId: null, userName: song.source.kind === 'created' ? 'New tab' : 'Original', message: 'Original',
        createdAt: song.addedAt, file: song.file, bytes: existsSync(this.absFile(song)) ? statSync(this.absFile(song)).size : 0,
      });
    }
    const rev = Math.max(0, ...this.store.revisions(song.id).map((r) => r.rev)) + 1;
    const file = join('revisions', song.id, `${rev}.gp`);
    mkdirSync(join(this.dataDir, 'revisions', song.id), { recursive: true });
    writeFileSync(join(this.dataDir, file), bytes);
    const r: Revision = { rev, songId: song.id, userId: user?.id ?? null, userName: user?.name ?? 'Someone', message: message.trim().slice(0, 200) || 'Edited', createdAt: Date.now(), file, bytes: bytes.length };
    this.store.addRevision(r);
    this.store.patch(song.id, {
      file, ext: 'gp', revision: rev, tracks: sum.tracks, instruments: sum.instruments, tempo: sum.tempo, bars: sum.bars, hasLyrics: sum.hasLyrics,
      title: sum.title || song.title, artist: sum.artist || song.artist,
    });
    return r;
  }

  /** Makes an existing revision the default one. */
  useRevision(song: SongRecord, rev: number): SongRecord {
    const r = this.store.revisions(song.id).find((x) => x.rev === rev);
    if (!r) throw Object.assign(new Error('That revision doesn’t exist.'), { statusCode: 404 });
    const path = isAbsolute(r.file) ? r.file : join(this.dataDir, r.file);
    const bytes = readFileSync(path);
    const score = loadScore(bytes, extOf(r.file) || 'gp');
    const sum = summarizeScore(score);
    return this.store.patch(song.id, {
      file: r.file, ext: extOf(r.file) || 'gp', revision: rev, tracks: sum.tracks, instruments: sum.instruments, tempo: sum.tempo,
      bars: sum.bars, hasLyrics: sum.hasLyrics,
    })!;
  }

  revisionPath(song: SongRecord, rev: number): string | null {
    const r = this.store.revisions(song.id).find((x) => x.rev === rev);
    if (!r) return rev === 0 ? this.absFile(song) : null;
    return isAbsolute(r.file) ? r.file : join(this.dataDir, r.file);
  }

  /** A brand-new tab made in the editor. */
  createSong(bytes: Uint8Array, user: { id: string; name: string } | null): SongRecord {
    const score = loadScore(bytes, 'gp');
    const id = shortId('created:' + Date.now() + ':' + Math.random());
    const rec = this.recordFromScore({ id, score, ext: 'gp', hash: contentHash(bytes), source: { kind: 'created', ref: id, variant: user ? `by ${user.name}` : undefined } });
    rec.createdBy = user?.id;
    this.store.put(rec);
    return rec;
  }

  /** Import (or re-import) a file from disk. Returns null when skipped as a duplicate. */
  importPath(path: string, kind: 'local' | 'upload' = 'local'): SongRecord | null {
    const ext = extOf(path);
    if (!ALL_EXTENSIONS.includes(ext)) throw new UnsupportedFormatError(`Unsupported file type .${ext}`);
    const st = statSync(path);
    const id = shortId('file:' + path);
    const existing = this.store.song(id);
    if (existing && existing.fileMtime === st.mtimeMs && !existing.missing) return existing;
    const bytes = readFileSync(path);
    const hash = contentHash(bytes);
    const dup = this.store.findByHash(hash);
    if (dup && dup.id !== id && dup.source.kind !== 'demo' && dup.source.ref !== path && existsSync(dup.source.ref || '/nonexistent')) {
      this.errors.set(path, { path, message: `Duplicate of “${dup.artist ? dup.artist + ' – ' : ''}${dup.title}”, skipped`, at: Date.now() });
      return null;
    }
    const score = loadScore(bytes, ext);
    const rec = this.recordFromScore({
      id, score, ext, sourcePath: path, hash, mtime: st.mtimeMs,
      source: { kind, ref: path }, fallback: titleFromFileName(path),
    });
    this.store.put(rec);
    this.errors.delete(path);
    return rec;
  }

  /** Save uploaded bytes into the library folder (so they're ordinary files) and import them. */
  importUpload(name: string, bytes: Uint8Array): SongRecord | null {
    const safe = basename(name).replace(/[^\w.\- ()&',!]+/g, '_');
    const dir = join(this.watchedDir || join(this.dataDir, 'library'), 'Imported');
    mkdirSync(dir, { recursive: true });
    let target = join(dir, safe);
    if (existsSync(target) && contentHash(readFileSync(target)) !== contentHash(bytes)) {
      target = join(dir, `${basename(safe, extname(safe))} (${Date.now()})${extname(safe)}`);
    }
    writeFileSync(target, bytes);
    try {
      return this.importPath(target, 'upload');
    } catch (e) {
      try { unlinkSync(target); } catch { /* ignore */ }
      throw e;
    }
  }

  /** Store a score that came from an online source or a generator. */
  importScore(opts: { score: alphaTab.model.Score; source: SongSource; title?: string; artist?: string; warnings?: string[] }): SongRecord {
    const id = shortId(`${opts.source.kind}:${opts.source.ref}`);
    const bytes = exportGp7(opts.score);
    const rec = this.recordFromScore({
      id, score: opts.score, ext: 'gp', hash: contentHash(bytes), source: opts.source,
      fallback: { title: opts.title ?? '', artist: opts.artist ?? '' }, warnings: opts.warnings,
    });
    this.store.put(rec);
    return rec;
  }

  importText(opts: { tab: TextTab; source: SongSource; title: string; artist: string; instruments: Instrument[] }): SongRecord {
    const id = shortId(`${opts.source.kind}:${opts.source.ref}`);
    const file = join('text', `${id}.json`);
    const json = JSON.stringify(opts.tab);
    writeFileSync(join(this.dataDir, file), json);
    const prev = this.store.song(id);
    const now = Date.now();
    const rec: SongRecord = {
      id, title: opts.title, artist: opts.artist, album: '', format: 'text', file, ext: 'txt', source: opts.source,
      tracks: [], instruments: opts.instruments, tempo: null, bars: 0, hasLyrics: /[a-z]{3,}/i.test(opts.tab.content),
      hash: contentHash(json), addedAt: prev?.addedAt ?? now, updatedAt: now,
    };
    this.store.put(rec);
    return rec;
  }

  remove(id: string) {
    const s = this.store.song(id);
    if (!s) return;
    if (!isAbsolute(s.file)) { try { unlinkSync(this.absFile(s)); } catch { /* already gone */ } }
    try { rmSync(join(this.dataDir, 'revisions', id), { recursive: true, force: true }); } catch { /* ignore */ }
    for (const a of this.store.audioFor(id)) {
      try { unlinkSync(join(this.dataDir, a.file)); } catch { /* ignore */ }
      this.store.removeAudio(a.id);
    }
    this.store.remove(id);
  }

  // ------------------------------------------------------------ watching

  private enqueue(fn: () => void) {
    this.queue = this.queue.then(() => new Promise<void>((res) => setImmediate(() => { try { fn(); } finally { res(); } })));
  }

  async watch(dir: string, opts: { polling?: boolean } = {}) {
    await this.unwatch();
    mkdirSync(dir, { recursive: true });
    this.watchedDir = dir;
    this.scanning = true;
    const handle = (path: string) => {
      if (!ALL_EXTENSIONS.includes(extOf(path))) return;
      this.enqueue(() => {
        try { this.importPath(path); }
        catch (e) { this.errors.set(path, { path, message: e instanceof Error ? e.message : String(e), at: Date.now() }); }
      });
    };
    const w = chokidar.watch(dir, {
      ignoreInitial: false,
      usePolling: opts.polling ?? process.env.FRETFORGE_POLL === '1',
      interval: 2000,
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
      ignored: (p, stats) => (stats?.isFile() ?? false) && !ALL_EXTENSIONS.includes(extOf(p)) || /(^|[/\\])\./.test(relative(dir, p) || ''),
    });
    w.on('add', handle).on('change', handle).on('unlink', (path) => {
      const s = this.store.song(shortId('file:' + path));
      if (s) this.store.patch(s.id, { missing: true });
    });
    w.on('ready', () => { this.queue.then(() => { this.scanning = false; }); });
    w.on('error', () => { /* keep watching */ });
    this.watcher = w;
    // Mark records whose files vanished while we weren't running
    for (const s of this.store.songs()) {
      if ((s.source.kind === 'local' || s.source.kind === 'upload') && !existsSync(s.source.ref)) this.store.patch(s.id, { missing: true });
    }
  }

  async unwatch() {
    if (this.watcher) await this.watcher.close();
    this.watcher = null;
  }

  async rescan() {
    for (const s of this.store.songs()) if (s.fileMtime) s.fileMtime = -1;
    if (this.watchedDir) await this.watch(this.watchedDir);
  }

  /** Resolves once queued imports are done. */
  idle(): Promise<unknown> { return this.queue; }

  // ------------------------------------------------------------ search

  private buildIndex() {
    const ms = new MiniSearch<{ id: string }>({
      fields: ['title', 'artist', 'album', 'tracks', 'tuning', 'variant'],
      storeFields: ['id'],
      searchOptions: { boost: { title: 3, artist: 2 }, fuzzy: 0.2, prefix: true, combineWith: 'AND' },
    });
    ms.addAll(this.store.songs().map((s) => ({
      id: s.id, title: s.title, artist: s.artist, album: s.album,
      tracks: s.tracks.map((t) => t.name).join(' '),
      tuning: [...new Set(s.tracks.map((t) => t.tuningName).filter(Boolean))].join(' '),
      variant: s.source.variant ?? '',
    })));
    this.index = ms;
    return ms;
  }

  list(q: ListQuery): SongRecord[] {
    let songs: SongRecord[];
    const text = (q.q ?? '').trim();
    if (text) {
      const idx = this.index ?? this.buildIndex();
      let hits = idx.search(text);
      if (!hits.length) hits = idx.search(text, { combineWith: 'OR' });
      songs = hits.map((h) => this.store.song(h.id as string)).filter((s): s is SongRecord => !!s);
    } else if (q.ids) {
      songs = q.ids.map((id) => this.store.song(id)).filter((s): s is SongRecord => !!s);
    } else {
      songs = this.store.songs();
    }
    if (q.ids && text) { const set = new Set(q.ids); songs = songs.filter((s) => set.has(s.id)); }
    songs = songs.map((s) => this.store.songFor(q.userId, s));
    if (q.instrument && q.instrument !== 'all') songs = songs.filter((s) => s.instruments.includes(q.instrument as Instrument));
    if (q.tuning) songs = songs.filter((s) => s.tracks.some((t) => t.tuningName === q.tuning));
    if (q.source) songs = songs.filter((s) => s.source.kind === q.source || (q.source === 'local' && s.source.kind === 'upload'));
    if (q.withAudio) songs = songs.filter((s) => (s.audioCount ?? 0) > 0);
    if (q.favorites) songs = songs.filter((s) => s.favorite);
    if (q.offline) songs = songs.filter((s) => s.offline);
    if (q.mine) songs = songs.filter((s) => s.createdBy === q.userId || this.store.revisions(s.id).some((r) => r.userId === q.userId));
    if (q.ids && !q.sort) return q.limit ? songs.slice(0, q.limit) : songs;
    if (!text || q.sort) {
      const sort = q.sort ?? 'artist';
      const key = (s: SongRecord) => (s.artist || '~').toLowerCase() + '\u0000' + s.title.toLowerCase();
      if (sort === 'title') songs.sort((a, b) => a.title.localeCompare(b.title));
      else if (sort === 'artist') songs.sort((a, b) => key(a).localeCompare(key(b)));
      else if (sort === 'added') songs.sort((a, b) => b.addedAt - a.addedAt);
      else if (sort === 'recent') songs.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
      else if (sort === 'played') songs.sort((a, b) => (b.openCount ?? 0) - (a.openCount ?? 0));
    }
    return q.limit ? songs.slice(0, q.limit) : songs;
  }

  copyInto(dir: string, song: SongRecord) {
    copyFileSync(this.absFile(song), join(dir, basename(this.absFile(song))));
  }
}

export { SCORE_EXTENSIONS };

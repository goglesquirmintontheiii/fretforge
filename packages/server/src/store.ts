import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { defaultPrefs, type Prefs, type SongRecord } from '@fretforge/shared';

interface DbShape {
  version: 1;
  songs: Record<string, SongRecord>;
  prefs: Prefs;
  auth: { hash?: string; salt?: string };
  sessions: Record<string, { createdAt: number }>;
  history: string[];
}

export function shortId(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12);
}

export function contentHash(bytes: Uint8Array | string): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** A small JSON-file database. Fine for a personal library of tens of thousands of songs. */
export class Store {
  private db: DbShape;
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private listeners = new Set<() => void>();

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, 'scores'), { recursive: true });
    mkdirSync(join(dataDir, 'text'), { recursive: true });
    this.file = join(dataDir, 'db.json');
    this.db = this.load();
  }

  private load(): DbShape {
    const empty: DbShape = { version: 1, songs: {}, prefs: { ...defaultPrefs }, auth: {}, sessions: {}, history: [] };
    if (!existsSync(this.file)) return empty;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<DbShape>;
      return {
        ...empty,
        ...raw,
        prefs: { ...defaultPrefs, ...(raw.prefs ?? {}), sources: { ...defaultPrefs.sources, ...(raw.prefs?.sources ?? {}) } },
        songs: raw.songs ?? {},
        history: raw.history ?? [],
        sessions: raw.sessions ?? {},
        auth: raw.auth ?? {},
      };
    } catch (e) {
      // Keep a copy of the unreadable file instead of silently overwriting it
      renameSync(this.file, this.file + '.corrupt-' + Date.now());
      return empty;
    }
  }

  private changed() {
    for (const l of this.listeners) l();
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 250);
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.db));
    renameSync(tmp, this.file);
  }

  // songs
  songs(): SongRecord[] { return Object.values(this.db.songs); }
  song(id: string): SongRecord | undefined { return this.db.songs[id]; }
  findBySource(kind: string, ref: string): SongRecord | undefined {
    return this.songs().find((s) => s.source.kind === kind && s.source.ref === ref);
  }
  findByHash(hash: string): SongRecord | undefined { return this.songs().find((s) => s.hash === hash); }
  put(song: SongRecord) { this.db.songs[song.id] = song; this.changed(); }
  patch(id: string, patch: Partial<SongRecord>): SongRecord | undefined {
    const s = this.db.songs[id];
    if (!s) return undefined;
    Object.assign(s, patch, { updatedAt: Date.now() });
    this.changed();
    return s;
  }
  remove(id: string) {
    delete this.db.songs[id];
    this.db.history = this.db.history.filter((h) => h !== id);
    this.changed();
  }

  // history
  history(): string[] { return this.db.history.filter((id) => this.db.songs[id]); }
  touch(id: string) {
    const s = this.db.songs[id];
    if (!s) return;
    s.lastOpenedAt = Date.now();
    s.openCount = (s.openCount ?? 0) + 1;
    this.db.history = [id, ...this.db.history.filter((h) => h !== id)].slice(0, 100);
    this.changed();
  }

  // prefs
  prefs(): Prefs { return this.db.prefs; }
  setPrefs(p: Partial<Prefs>): Prefs {
    this.db.prefs = { ...this.db.prefs, ...p, sources: { ...this.db.prefs.sources, ...(p.sources ?? {}) } };
    this.changed();
    return this.db.prefs;
  }

  // auth
  auth() { return this.db.auth; }
  setAuth(a: { hash: string; salt: string }) { this.db.auth = a; this.changed(); this.flush(); }
  hasSession(id: string) { return !!this.db.sessions[id]; }
  addSession(id: string) { this.db.sessions[id] = { createdAt: Date.now() }; this.changed(); }
  dropSession(id: string) { delete this.db.sessions[id]; this.changed(); }
}

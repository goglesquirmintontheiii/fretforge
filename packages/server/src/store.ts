import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  defaultAi, defaultPrefs, USER_PREF_KEYS,
  type AudioAsset, type Comment, type Invite, type Job, type Playlist, type PracticeState, type Prefs, type PublicUser,
  type Revision, type RigDoc, type RigFile, type RigPreset, type Role, type Setlist, type ShareLink, type SongRecord,
} from '@fretforge/shared';

export interface UserRecord extends PublicUser {
  hash?: string;
  salt?: string;
  /** OIDC subject */
  sub?: string;
  prefs: Partial<Prefs>;
  /** comment ids that mention this user and haven't been seen */
  unreadMentions?: string[];
  /** TONE3000 API session */
  tone3000?: { access: string; refresh: string; expiresAt: number; username?: string };
}

export interface UserSongState {
  favorite?: boolean;
  practice?: PracticeState;
  lastOpenedAt?: number;
  openCount?: number;
  /** pinned for offline use (PWA) */
  offline?: boolean;
}

interface DbShape {
  version: 2;
  songs: Record<string, SongRecord>;
  prefs: Prefs;
  users: Record<string, UserRecord>;
  invites: Record<string, Invite>;
  sessions: Record<string, { userId: string; createdAt: number }>;
  userSongs: Record<string, Record<string, UserSongState>>;
  history: Record<string, string[]>;
  playlists: Record<string, Playlist>;
  comments: Record<string, Comment>;
  revisions: Record<string, Revision[]>;
  shares: Record<string, ShareLink>;
  rigFiles: Record<string, RigFile>;
  rigPresets: Record<string, RigPreset>;
  audio: Record<string, AudioAsset>;
  jobs: Record<string, Job>;
  rigs: Record<string, RigDoc>;
  setlists: Record<string, Setlist>;
  /** small server-level values (UG device id ...) */
  meta: Record<string, string>;
}

/** The user that owns a desktop install (and the first account of a v1 server database). */
export const LOCAL_USER_ID = 'local';

export function shortId(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12);
}

export function newId(): string {
  return randomBytes(9).toString('base64url');
}

export function contentHash(bytes: Uint8Array | string): string {
  return createHash('sha1').update(bytes).digest('hex');
}

const SONG_USER_FIELDS = ['favorite', 'practice', 'lastOpenedAt', 'openCount'] as const;

/** A small JSON-file database. Fine for a personal library of tens of thousands of songs. */
export class Store {
  private db: DbShape;
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private listeners = new Set<() => void>();

  constructor(readonly dataDir: string) {
    for (const d of ['', 'scores', 'text', 'revisions', 'rig', 'audio']) mkdirSync(join(dataDir, d), { recursive: true });
    this.file = join(dataDir, 'db.json');
    this.db = this.load();
  }

  private empty(): DbShape {
    return {
      version: 2, songs: {}, prefs: { ...defaultPrefs }, users: {}, invites: {}, sessions: {}, userSongs: {}, history: {},
      playlists: {}, comments: {}, revisions: {}, shares: {}, rigFiles: {}, rigPresets: {}, audio: {}, jobs: {}, rigs: {}, setlists: {}, meta: {},
    };
  }

  private load(): DbShape {
    const empty = this.empty();
    if (!existsSync(this.file)) return empty;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      // Keep a copy of the unreadable file instead of silently overwriting it
      renameSync(this.file, this.file + '.corrupt-' + Date.now());
      return empty;
    }
    const db = { ...empty, ...(raw as Partial<DbShape>) } as DbShape;
    const rp = (raw.prefs ?? {}) as Partial<Prefs>;
    db.prefs = { ...defaultPrefs, ...rp, sources: { ...defaultPrefs.sources, ...(rp.sources ?? {}) }, ai: { ...defaultAi, ...(rp.ai ?? {}) } };
    if (raw.version !== 2) this.migrateV1(db, raw);
    // tolerate interrupted jobs
    for (const j of Object.values(db.jobs)) if (j.state === 'running') { j.state = 'queued'; j.progress = 0; j.message = 'Restarted'; }
    return db;
  }

  /** v1 kept one password and per-song personal fields on the song itself. */
  private migrateV1(db: DbShape, raw: Record<string, unknown>) {
    db.version = 2;
    const auth = (raw.auth ?? {}) as { hash?: string; salt?: string };
    db.users = {};
    db.users[LOCAL_USER_ID] = { id: LOCAL_USER_ID, name: 'Owner', role: 'owner', createdAt: Date.now(), hash: auth.hash, salt: auth.salt, prefs: {} };
    if (!auth.hash) delete db.users[LOCAL_USER_ID];
    db.sessions = {};
    db.history = { [LOCAL_USER_ID]: Array.isArray(raw.history) ? (raw.history as string[]) : [] };
    db.userSongs = { [LOCAL_USER_ID]: {} };
    for (const s of Object.values(db.songs)) {
      const st: UserSongState = {};
      for (const k of SONG_USER_FIELDS) {
        const v = (s as unknown as Record<string, unknown>)[k];
        if (v !== undefined) (st as Record<string, unknown>)[k] = v;
        delete (s as unknown as Record<string, unknown>)[k];
      }
      if (Object.keys(st).length) db.userSongs[LOCAL_USER_ID][s.id] = st;
    }
    delete (db as unknown as Record<string, unknown>).auth;
  }

  private changed() {
    for (const l of this.listeners) l();
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 250);
  }

  touchDb() { this.changed(); }

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

  // ------------------------------------------------------------------ songs
  songs(): SongRecord[] { return Object.values(this.db.songs); }
  song(id: string): SongRecord | undefined { return this.db.songs[id]; }
  findBySource(kind: string, ref: string): SongRecord | undefined {
    return this.songs().find((s) => s.source.kind === kind && s.source.ref === ref);
  }
  findByHash(hash: string): SongRecord | undefined { return this.songs().find((s) => s.hash === hash); }
  put(song: SongRecord) {
    for (const k of SONG_USER_FIELDS) delete (song as unknown as Record<string, unknown>)[k];
    this.db.songs[song.id] = song;
    this.changed();
  }
  patch(id: string, patch: Partial<SongRecord>): SongRecord | undefined {
    const s = this.db.songs[id];
    if (!s) return undefined;
    Object.assign(s, patch, { updatedAt: Date.now() });
    this.changed();
    return s;
  }
  remove(id: string) {
    delete this.db.songs[id];
    for (const h of Object.values(this.db.history)) { const i = h.indexOf(id); if (i >= 0) h.splice(i, 1); }
    for (const us of Object.values(this.db.userSongs)) delete us[id];
    for (const p of Object.values(this.db.playlists)) p.songIds = p.songIds.filter((x) => x !== id);
    for (const c of Object.values(this.db.comments)) if (c.songId === id) delete this.db.comments[c.id];
    for (const s of Object.values(this.db.shares)) if (s.songId === id) delete this.db.shares[s.token];
    delete this.db.revisions[id];
    this.changed();
  }

  /** A song with the given user's personal fields filled in. */
  songFor(userId: string, s: SongRecord): SongRecord {
    const st = this.db.userSongs[userId]?.[s.id];
    const extra = {
      revisionCount: (this.db.revisions[s.id]?.length ?? 0) || undefined,
      audioCount: this.audioFor(s.id).length || undefined,
      commentCount: this.commentsFor(s.id).length || undefined,
    };
    return st ? { ...s, ...extra, favorite: st.favorite, practice: st.practice, lastOpenedAt: st.lastOpenedAt, openCount: st.openCount, offline: st.offline } : { ...s, ...extra };
  }

  userSong(userId: string, songId: string): UserSongState {
    const m = (this.db.userSongs[userId] ??= {});
    return (m[songId] ??= {});
  }
  userSongs(userId: string): Record<string, UserSongState> { return this.db.userSongs[userId] ?? {}; }
  patchUserSong(userId: string, songId: string, patch: Partial<UserSongState>) {
    Object.assign(this.userSong(userId, songId), patch);
    this.changed();
  }

  // ------------------------------------------------------------------ history
  history(userId: string): string[] { return (this.db.history[userId] ?? []).filter((id) => this.db.songs[id]); }
  touch(userId: string, id: string) {
    if (!this.db.songs[id]) return;
    const st = this.userSong(userId, id);
    st.lastOpenedAt = Date.now();
    st.openCount = (st.openCount ?? 0) + 1;
    this.db.history[userId] = [id, ...(this.db.history[userId] ?? []).filter((h) => h !== id)].slice(0, 100);
    this.changed();
  }

  // ------------------------------------------------------------------ prefs
  /** Server-wide prefs merged with the user's own. */
  prefs(userId?: string): Prefs {
    const u = userId ? this.db.users[userId] : undefined;
    return u ? { ...this.db.prefs, ...u.prefs } : this.db.prefs;
  }
  setPrefs(p: Partial<Prefs>, userId?: string, canChangeServer = true): Prefs {
    const userPart: Partial<Prefs> = {};
    const serverPart: Partial<Prefs> = {};
    for (const [k, v] of Object.entries(p)) {
      if ((USER_PREF_KEYS as readonly string[]).includes(k) && userId && this.db.users[userId]) (userPart as Record<string, unknown>)[k] = v;
      else (serverPart as Record<string, unknown>)[k] = v;
    }
    if (canChangeServer && Object.keys(serverPart).length) {
      this.db.prefs = {
        ...this.db.prefs, ...serverPart,
        sources: { ...this.db.prefs.sources, ...(serverPart.sources ?? {}) },
        ai: { ...this.db.prefs.ai, ...(serverPart.ai ?? {}) },
      };
    }
    if (userId && this.db.users[userId] && Object.keys(userPart).length) Object.assign(this.db.users[userId].prefs, userPart);
    this.changed();
    return this.prefs(userId);
  }

  // ------------------------------------------------------------------ users and sessions
  users(): UserRecord[] { return Object.values(this.db.users); }
  user(id: string): UserRecord | undefined { return this.db.users[id]; }
  userByName(name: string): UserRecord | undefined {
    const n = name.trim().toLowerCase();
    return this.users().find((u) => u.name.toLowerCase() === n);
  }
  userBySub(sub: string): UserRecord | undefined { return this.users().find((u) => u.sub === sub); }
  putUser(u: UserRecord) { this.db.users[u.id] = u; this.changed(); this.flush(); }
  removeUser(id: string) {
    delete this.db.users[id];
    for (const [sid, s] of Object.entries(this.db.sessions)) if (s.userId === id) delete this.db.sessions[sid];
    delete this.db.userSongs[id];
    delete this.db.history[id];
    for (const p of Object.values(this.db.playlists)) if (p.ownerId === id) delete this.db.playlists[p.id];
    for (const r of Object.values(this.db.rigs)) if (r.ownerId === id && !r.shared) delete this.db.rigs[r.id];
    for (const sl of Object.values(this.db.setlists)) if (sl.ownerId === id) delete this.db.setlists[sl.id];
    this.changed();
  }
  ensureLocalUser(): UserRecord {
    let u = this.db.users[LOCAL_USER_ID];
    if (!u) {
      u = { id: LOCAL_USER_ID, name: 'You', role: 'owner', createdAt: Date.now(), prefs: {} };
      this.db.users[LOCAL_USER_ID] = u;
      this.changed();
    }
    return u;
  }
  session(id: string) { return this.db.sessions[id]; }
  addSession(id: string, userId: string) { this.db.sessions[id] = { userId, createdAt: Date.now() }; this.changed(); }
  dropSession(id: string) { delete this.db.sessions[id]; this.changed(); }

  invites(): Invite[] { return Object.values(this.db.invites); }
  invite(token: string): Invite | undefined { return this.db.invites[token]; }
  putInvite(i: Invite) { this.db.invites[i.token] = i; this.changed(); }
  removeInvite(token: string) { delete this.db.invites[token]; this.changed(); }

  // ------------------------------------------------------------------ playlists
  playlists(): Playlist[] { return Object.values(this.db.playlists); }
  playlist(id: string): Playlist | undefined { return this.db.playlists[id]; }
  putPlaylist(p: Playlist) { this.db.playlists[p.id] = p; this.changed(); }
  removePlaylist(id: string) { delete this.db.playlists[id]; this.changed(); }

  // ------------------------------------------------------------------ comments
  commentsFor(songId: string): Comment[] {
    return Object.values(this.db.comments).filter((c) => c.songId === songId).sort((a, b) => a.createdAt - b.createdAt);
  }
  comment(id: string): Comment | undefined { return this.db.comments[id]; }
  putComment(c: Comment) { this.db.comments[c.id] = c; this.changed(); }
  removeComment(id: string) { delete this.db.comments[id]; this.changed(); }

  // ------------------------------------------------------------------ revisions
  revisions(songId: string): Revision[] { return this.db.revisions[songId] ?? []; }
  addRevision(r: Revision) { (this.db.revisions[r.songId] ??= []).push(r); this.changed(); }

  // ------------------------------------------------------------------ shares
  shares(): ShareLink[] { return Object.values(this.db.shares); }
  share(token: string): ShareLink | undefined { return this.db.shares[token]; }
  putShare(s: ShareLink) { this.db.shares[s.token] = s; this.changed(); }
  removeShare(token: string) { delete this.db.shares[token]; this.changed(); }

  // ------------------------------------------------------------------ rig library
  rigFiles(): RigFile[] { return Object.values(this.db.rigFiles).sort((a, b) => a.name.localeCompare(b.name)); }
  rigFile(id: string): RigFile | undefined { return this.db.rigFiles[id]; }
  putRigFile(f: RigFile) { this.db.rigFiles[f.id] = f; this.changed(); }
  removeRigFile(id: string) { delete this.db.rigFiles[id]; this.changed(); }
  rigPresets(): RigPreset[] { return Object.values(this.db.rigPresets); }
  rigPreset(id: string): RigPreset | undefined { return this.db.rigPresets[id]; }
  putRigPreset(p: RigPreset) { this.db.rigPresets[p.id] = p; this.changed(); }
  removeRigPreset(id: string) { delete this.db.rigPresets[id]; this.changed(); }
  rigFileByHash(hash: string): RigFile | undefined { return Object.values(this.db.rigFiles).find((f) => f.hash === hash); }

  // ------------------------------------------------------------------ rigs (rig editor) and setlists
  rigs(): RigDoc[] { return Object.values(this.db.rigs).sort((a, b) => a.name.localeCompare(b.name)); }
  rig(id: string): RigDoc | undefined { return this.db.rigs[id]; }
  putRig(r: RigDoc) { this.db.rigs[r.id] = r; this.changed(); }
  removeRig(id: string) {
    delete this.db.rigs[id];
    for (const sl of Object.values(this.db.setlists)) sl.rigIds = sl.rigIds.filter((x) => x !== id);
    this.changed();
  }
  setlists(): Setlist[] { return Object.values(this.db.setlists).sort((a, b) => a.name.localeCompare(b.name)); }
  setlist(id: string): Setlist | undefined { return this.db.setlists[id]; }
  putSetlist(s: Setlist) { this.db.setlists[s.id] = s; this.changed(); }
  removeSetlist(id: string) { delete this.db.setlists[id]; this.changed(); }
  meta(key: string): string | undefined { return this.db.meta[key]; }
  setMeta(key: string, value: string) { this.db.meta[key] = value; this.changed(); }

  // ------------------------------------------------------------------ audio
  audioFor(songId: string): AudioAsset[] {
    return Object.values(this.db.audio).filter((a) => a.songId === songId).sort((a, b) => a.createdAt - b.createdAt);
  }
  allAudio(): AudioAsset[] { return Object.values(this.db.audio); }
  audio(id: string): AudioAsset | undefined { return this.db.audio[id]; }
  putAudio(a: AudioAsset) { this.db.audio[a.id] = a; this.changed(); }
  removeAudio(id: string) { delete this.db.audio[id]; this.changed(); }

  // ------------------------------------------------------------------ jobs
  jobs(): Job[] { return Object.values(this.db.jobs).sort((a, b) => b.createdAt - a.createdAt); }
  job(id: string): Job | undefined { return this.db.jobs[id]; }
  putJob(j: Job) { this.db.jobs[j.id] = j; this.changed(); }
  removeJob(id: string) { delete this.db.jobs[id]; this.changed(); }

  hasRole(userId: string | null | undefined, ...roles: Role[]): boolean {
    const u = userId ? this.db.users[userId] : undefined;
    return !!u && roles.includes(u.role);
  }
}

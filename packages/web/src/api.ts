import type { TranscribeOptions, AmpSettings, AudioAsset, Comment, Instrument, Invite, Job, NamRole, NamSearchModel, NamSearchQuery, NamSearchResponse, NamSearchResult, NamSearchSource, OnlineResult, OnlineSearchResponse, Playlist, Prefs, PublicUser, Revision, RigDoc, RigFile, RigPreset, Role, Setlist, ShareLink, SongRecord, StatusResponse, SyncPoint, TextTab } from '@fretforge/shared';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError('Fretforge’s server isn’t answering. Is it still running?', 0);
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  if (!res.ok) {
    const body = isJson ? await res.json().catch(() => ({})) : {};
    throw new ApiError((body as { error?: string }).error || `Request failed (${res.status})`, res.status);
  }
  return (isJson ? res.json() : res.arrayBuffer()) as Promise<T>;
}

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const bin = (body: BodyInit): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });
const files = (fs: File[], field = 'file') => {
  const fd = new FormData();
  for (const f of fs) fd.append(field, f, f.name);
  return { method: 'POST', body: fd } as RequestInit;
};

export interface RigImport { added: RigFile[]; existing: RigFile[]; errors: { name: string; message: string }[] }

export interface Facet { name: string; count: number }
export interface LibraryFacets { tunings: (Facet & { family: string | null })[]; families: Facet[]; bodies: Facet[]; tones: Facet[] }
export interface SongQuery { q?: string; instrument?: Instrument | 'all'; sort?: string; favorites?: boolean; limit?: number; tuning?: string; family?: string; body?: string; tone?: string; source?: string; audio?: boolean; playlist?: string; mine?: boolean; offline?: boolean }

export const api = {
  status: () => call<StatusResponse>('/api/status'),
  setup: (password: string, name?: string) => call('/api/setup', json({ password, name })),
  login: (password: string, name?: string) => call('/api/login', json({ password, name })),
  logout: () => call('/api/logout', { method: 'POST' }),
  me: () => call<{ user: PublicUser | null; mentions: Comment[] }>('/api/me'),
  readMentions: () => call('/api/me/mentions/read', { method: 'POST' }),
  changePassword: (current: string, next: string) => call('/api/me/password', json({ current, next })),
  renameMe: (name: string) => call<PublicUser>('/api/me', json({ name }, 'PATCH')),
  users: () => call<{ users: PublicUser[] }>('/api/users'),
  setRole: (id: string, role: Role) => call<PublicUser>(`/api/users/${id}`, json({ role }, 'PATCH')),
  removeUser: (id: string) => call(`/api/users/${id}`, { method: 'DELETE' }),
  invites: () => call<{ invites: Invite[] }>('/api/invites'),
  createInvite: (role: Role, days = 7) => call<Invite>('/api/invites', json({ role, days })),
  deleteInvite: (token: string) => call(`/api/invites/${token}`, { method: 'DELETE' }),
  invite: (token: string) => call<{ valid: boolean; role: Role | null; by: string | null }>(`/api/invites/${token}`),
  acceptInvite: (token: string, name: string, password: string) => call(`/api/invites/${token}/accept`, json({ name, password })),

  songs: (q: SongQuery = {}) => {
    const p = new URLSearchParams();
    if (q.q) p.set('q', q.q);
    if (q.instrument && q.instrument !== 'all') p.set('instrument', q.instrument);
    if (q.sort) p.set('sort', q.sort);
    if (q.favorites) p.set('favorites', '1');
    if (q.limit) p.set('limit', String(q.limit));
    if (q.tuning) p.set('tuning', q.tuning);
    if (q.family) p.set('family', q.family);
    if (q.body) p.set('body', q.body);
    if (q.tone) p.set('tone', q.tone);
    if (q.source) p.set('source', q.source);
    if (q.audio) p.set('audio', '1');
    if (q.playlist) p.set('playlist', q.playlist);
    if (q.mine) p.set('mine', '1');
    if (q.offline) p.set('offline', '1');
    return call<{ songs: SongRecord[]; total: number }>(`/api/songs?${p}`);
  },
  facets: () => call<LibraryFacets>('/api/library/facets'),
  offlineSongs: () => call<{ songs: SongRecord[] }>('/api/offline'),
  createSong: (bytes: Uint8Array) => call<SongRecord>('/api/songs', bin(bytes as BodyInit)),
  revisions: (id: string) => call<{ current: number; revisions: Revision[] }>(`/api/songs/${id}/revisions`),
  saveRevision: (id: string, bytes: Uint8Array, message: string) => call<{ revision: Revision; song: SongRecord }>(`/api/songs/${id}/revisions?message=${encodeURIComponent(message)}`, bin(bytes as BodyInit)),
  revisionFile: (id: string, rev: number) => call<ArrayBuffer>(`/api/songs/${id}/revisions/${rev}/file`),
  useRevision: (id: string, rev: number) => call<SongRecord>(`/api/songs/${id}/revisions/${rev}/default`, { method: 'POST' }),
  comments: (id: string) => call<{ comments: Comment[] }>(`/api/songs/${id}/comments`),
  addComment: (id: string, text: string, bar: number | null) => call<Comment>(`/api/songs/${id}/comments`, json({ text, bar })),
  deleteComment: (id: string) => call(`/api/comments/${id}`, { method: 'DELETE' }),
  share: (id: string) => call<ShareLink>(`/api/songs/${id}/share`, { method: 'POST' }),
  shares: () => call<{ shares: (ShareLink & { title: string })[] }>('/api/shares'),
  unshare: (token: string) => call(`/api/shares/${token}`, { method: 'DELETE' }),
  shared: (token: string) => call<SongRecord>(`/api/share/${token}`),
  sharedFile: (token: string) => call<ArrayBuffer>(`/api/share/${token}/file`),
  sharedText: (token: string) => call<TextTab>(`/api/share/${token}/file`),
  playlists: () => call<{ playlists: Playlist[] }>('/api/playlists'),
  createPlaylist: (name: string, songIds: string[] = []) => call<Playlist>('/api/playlists', json({ name, songIds })),
  patchPlaylist: (id: string, p: { name?: string; songIds?: string[]; shared?: boolean; add?: string[]; remove?: string[] }) => call<Playlist>(`/api/playlists/${id}`, json(p, 'PATCH')),
  deletePlaylist: (id: string) => call(`/api/playlists/${id}`, { method: 'DELETE' }),
  separatePlaylist: (id: string, scheduled = true) => call<{ added: Job[] }>(`/api/playlists/${id}/separate`, json({ scheduled })),

  rigFiles: () => call<{ files: RigFile[] }>('/api/rig/files'),
  uploadRigFiles: (fs: File[], role: NamRole | 'auto' = 'auto') => {
    const fd = new FormData();
    fd.append('role', role);
    for (const f of fs) fd.append('file', f, f.name);
    return call<RigImport>('/api/rig/files', { method: 'POST', body: fd });
  },
  patchRigFile: (id: string, p: Partial<RigFile>) => call<RigFile>(`/api/rig/files/${id}`, json(p, 'PATCH')),
  deleteRigFile: (id: string) => call(`/api/rig/files/${id}`, { method: 'DELETE' }),
  rigPresets: () => call<{ presets: RigPreset[] }>('/api/rig/presets'),
  saveRigPreset: (name: string, amp: AmpSettings) => call<RigPreset>('/api/rig/presets', json({ name, amp })),
  patchRigPreset: (id: string, p: { name?: string; amp?: AmpSettings }) => call<RigPreset>(`/api/rig/presets/${id}`, json(p, 'PATCH')),
  deleteRigPreset: (id: string) => call(`/api/rig/presets/${id}`, { method: 'DELETE' }),
  rigs: () => call<{ rigs: RigDoc[] }>('/api/rigs'),
  rig: (id: string) => call<RigDoc>(`/api/rigs/${id}`),
  createRig: (r: Partial<RigDoc>) => call<RigDoc>('/api/rigs', json(r)),
  saveRig: (r: RigDoc) => call<RigDoc>(`/api/rigs/${r.id}`, json(r, 'PUT')),
  deleteRig: (id: string) => call(`/api/rigs/${id}`, { method: 'DELETE' }),
  setlists: () => call<{ setlists: Setlist[] }>('/api/setlists'),
  createSetlist: (name: string, rigIds: string[] = []) => call<Setlist>('/api/setlists', json({ name, rigIds })),
  saveSetlist: (id: string, p: { name?: string; rigIds?: string[] }) => call<Setlist>(`/api/setlists/${id}`, json(p, 'PUT')),
  deleteSetlist: (id: string) => call(`/api/setlists/${id}`, { method: 'DELETE' }),
  namSources: () => call<{ tone3000: { configured: boolean; connected: boolean; username: string | null }; github: string[] }>('/api/nam/sources'),
  namSearch: (source: NamSearchSource, query: Partial<NamSearchQuery>, signal?: AbortSignal) => call<NamSearchResponse>('/api/nam/search', { ...json({ source, query }), signal }),
  namImport: (p: { source: NamSearchSource; id: string; modelIds?: string[]; role?: NamRole | 'auto' }) => call<RigImport>('/api/nam/import', json(p)),
  tone3000Connect: (select = false, types: string[] = []) => call<{ url: string }>(`/api/nam/tone3000/connect?select=${select ? 1 : 0}&types=${types.join(',')}`),
  tone3000Selected: () => call<{ toneId: string | null }>('/api/nam/tone3000/selected'),
  tone3000Tone: (id: string) => call<{ tone: NamSearchResult; models: NamSearchModel[] }>(`/api/nam/tone3000/tones/${id}`),
  tone3000Disconnect: () => call('/api/nam/tone3000/disconnect', { method: 'POST' }),
  namGithubSources: (sources: string[]) => call<{ github: string[] }>('/api/nam/github', json({ sources }, 'PUT')),
  trainNam: (wav: Blob, name: string, epochs: number) => call<Job>(`/api/rig/train?name=${encodeURIComponent(name)}&epochs=${epochs}`, bin(wav)),

  audio: (songId: string) => call<{ audio: AudioAsset[] }>(`/api/songs/${songId}/audio`),
  uploadAudio: (songId: string, fs: File[]) => call<{ added: AudioAsset[] }>(`/api/songs/${songId}/audio`, files(fs)),
  patchAudio: (id: string, p: Partial<AudioAsset> & { syncPoints?: SyncPoint[] }) => call<AudioAsset>(`/api/audio/${id}`, json(p, 'PATCH')),
  deleteAudio: (id: string) => call(`/api/audio/${id}`, { method: 'DELETE' }),
  separate: (id: string, scheduled = false) => call<Job>(`/api/audio/${id}/separate`, json({ scheduled })),
  align: (id: string, wav: Blob, bars: { bar: number; occurrence: number; ms: number }[]) => {
    const fd = new FormData();
    fd.append('bars', new Blob([JSON.stringify(bars)], { type: 'application/json' }), 'bars.json');
    fd.append('render', wav, 'render.wav');
    return call<Job>(`/api/audio/${id}/align`, { method: 'POST', body: fd });
  },
  addVideo: (songId: string, url: string, name?: string) => call<AudioAsset>(`/api/songs/${songId}/videos`, json({ url, name })),
  songsterrVideos: (songId: string) => call<{ videos: AudioAsset[] }>(`/api/songs/${songId}/videos/songsterr`, { method: 'POST' }),
  transcribe: (b: { url?: string; audioId?: string; options: TranscribeOptions }) => call<Job>('/api/transcribe', json(b)),
  transcribeUpload: (file: File, options: TranscribeOptions) => {
    const fd = new FormData();
    fd.append('options', JSON.stringify(options));
    fd.append('file', file, file.name);
    return call<Job>('/api/transcribe/upload', { method: 'POST', body: fd });
  },
  publishSong: (id: string) => call<SongRecord>(`/api/songs/${id}/publish`, json({})),
  reviewBars: (id: string, bars: number[], reviewed = true) => call<SongRecord>(`/api/songs/${id}/ai/review`, json({ bars, reviewed })),
  simplify: (id: string, kind: string, factor?: number) => call<{ revision: Revision; song: SongRecord }>(`/api/songs/${id}/simplify`, json({ kind, factor })),
  youtube: (songId: string, url: string) => call<Job>(`/api/songs/${songId}/youtube`, json({ url })),
  jobs: () => call<{ jobs: Job[]; ai: StatusResponse['ai'] }>('/api/jobs'),
  cancelJob: (id: string) => call(`/api/jobs/${id}`, { method: 'DELETE' }),
  clearJobs: () => call('/api/jobs/clear', { method: 'POST' }),
  aiSetup: (device: string) => call<Job>('/api/ai/setup', json({ device })),
  aiCheck: () => call<StatusResponse['ai']>('/api/ai/check', { method: 'POST' }),
  song: (id: string) => call<SongRecord>(`/api/songs/${id}`),
  patchSong: (id: string, patch: Partial<SongRecord> & { offline?: boolean }) => call<SongRecord>(`/api/songs/${id}`, json(patch, 'PATCH')),
  deleteSong: (id: string, deleteFile = false) => call(`/api/songs/${id}${deleteFile ? '?file=1' : ''}`, { method: 'DELETE' }),
  songFile: (id: string) => call<ArrayBuffer>(`/api/songs/${id}/file`),
  songText: (id: string) => call<TextTab>(`/api/songs/${id}/text`),
  opened: (id: string) => call(`/api/songs/${id}/opened`, { method: 'POST' }),
  history: () => call<{ songs: SongRecord[] }>('/api/history'),

  importFiles: (files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    return call<{ imported: SongRecord[]; errors: { name: string; message: string }[] }>('/api/import', { method: 'POST', body: fd });
  },
  libraryStatus: () => call<{ dir: string; scanning: boolean; songCount: number; errors: { path: string; message: string; at: number }[] }>('/api/library/status'),
  rescan: () => call('/api/library/rescan', { method: 'POST' }),

  prefs: () => call<Prefs>('/api/prefs'),
  savePrefs: (p: Partial<Prefs>) => call<Prefs>('/api/prefs', json(p, 'PUT')),

  onlineSearch: (source: OnlineResult['source'], q: string, signal?: AbortSignal) =>
    call<OnlineSearchResponse>(`/api/online/search?source=${source}&q=${encodeURIComponent(q)}`, { signal }),
  verifyOnline: (source: OnlineResult['source']) => call<{ ok: true }>('/api/online/verify', json({ source })),
  openOnline: (source: OnlineResult['source'], ref: string, refresh = false) => call<SongRecord>('/api/online/open', json({ source, ref, refresh })),
};

import type { OnlineResult, OnlineSearchResponse, Prefs, SongRecord, StatusResponse, TextTab, Instrument } from '@fretforge/shared';

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

export const api = {
  status: () => call<StatusResponse>('/api/status'),
  setup: (password: string) => call('/api/setup', json({ password })),
  login: (password: string) => call('/api/login', json({ password })),
  logout: () => call('/api/logout', { method: 'POST' }),

  songs: (q: { q?: string; instrument?: Instrument | 'all'; sort?: string; favorites?: boolean; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.q) p.set('q', q.q);
    if (q.instrument && q.instrument !== 'all') p.set('instrument', q.instrument);
    if (q.sort) p.set('sort', q.sort);
    if (q.favorites) p.set('favorites', '1');
    if (q.limit) p.set('limit', String(q.limit));
    return call<{ songs: SongRecord[]; total: number }>(`/api/songs?${p}`);
  },
  song: (id: string) => call<SongRecord>(`/api/songs/${id}`),
  patchSong: (id: string, patch: Partial<SongRecord>) => call<SongRecord>(`/api/songs/${id}`, json(patch, 'PATCH')),
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
  openOnline: (source: OnlineResult['source'], ref: string, refresh = false) => call<SongRecord>('/api/online/open', json({ source, ref, refresh })),
};

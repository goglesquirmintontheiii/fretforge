// TONE3000 (https://www.tone3000.com) through its public API, within the free tier: the user
// signs in with OAuth (PKCE), picks tones in TONE3000's own picker (select flow) and Fretforge
// lists trending/latest tones and the user's favorites, downloads and creations. The catalog
// search endpoint is for approved partners, so it isn't used. Model files are downloaded only
// when the user asks for them.
import { createHash, randomBytes } from 'node:crypto';
import { guessGenres, guessTones, matchesAny, type NamSearchModel, type NamSearchQuery, type NamSearchResult, type NamType } from '@fretforge/shared';
import { ProviderError, type ProviderContext } from './http';

export const T3K_SITE = 'https://www.tone3000.com';
const API = `${T3K_SITE}/api/v1`;

export interface T3kSession { access: string; refresh: string; expiresAt: number; username?: string }

interface T3kUser { id: number; username: string; display_name?: string | null; avatar_url?: string | null; url?: string }
interface T3kTone {
  id: number; title: string; description?: string; url?: string; user?: T3kUser; gear?: string; format?: string; license?: string;
  sizes?: string[]; makes?: { id: number; name: string }[]; tags?: { id: number; name: string }[]; images?: string[];
  models_count?: number; downloads_count?: number; favorites_count?: number; is_public?: boolean;
}
interface T3kModel { id: number; name: string; size?: string; model_url: string; architecture_version?: string | null }
interface Page<T> { data: T[]; page?: number; page_size?: number; total?: number; total_pages?: number }

const GEAR_FOR_TYPE: Partial<Record<NamType, string>> = { amp: 'amp', preamp: 'amp', 'full-rig': 'amp-cab', pedal: 'pedal', cab: 'cab', outboard: 'outboard', experimental: 'experimental' };

export function typeOfTone(t: T3kTone): NamType {
  if (t.format === 'ir') return 'ir';
  const tags = (t.tags ?? []).map((x) => x.name.toLowerCase());
  switch (t.gear) {
    case 'amp': return tags.some((x) => x.includes('preamp')) || /pre-?amp/i.test(t.title) ? 'preamp' : 'amp';
    case 'amp-cab': case 'full-rig': return 'full-rig';
    case 'pedal': return 'pedal';
    case 'cab': return 'cab';
    case 'outboard': return 'outboard';
    case 'experimental': case 'space': return 'experimental';
    default: return 'amp';
  }
}

export function toneToResult(t: T3kTone): NamSearchResult {
  const tags = (t.tags ?? []).map((x) => x.name);
  const makes = (t.makes ?? []).map((x) => x.name);
  const text = `${t.title} ${tags.join(' ')} ${makes.join(' ')}`;
  const tones = guessTones(text);
  const genres = guessGenres(text, tones);
  // TONE3000 tags often name the genre or tone directly
  for (const tag of tags) {
    const cap = tag.replace(/\b\w/g, (c) => c.toUpperCase());
    if (/^(metal|djent|rock|blues|jazz|country|funk|pop|punk|worship|ambient|doom|grunge|indie)$/i.test(tag) && !genres.includes(cap)) genres.push(cap);
  }
  return {
    source: 'tone3000', id: String(t.id), title: t.title, creator: t.user?.display_name || t.user?.username, creatorUrl: t.user?.url,
    avatar: t.user?.avatar_url ?? null, url: t.url || `${T3K_SITE}/tones/${t.id}`, type: typeOfTone(t), tags, tones, genres, makes,
    license: t.license, modelCount: t.models_count, downloads: t.downloads_count, favorites: t.favorites_count, image: t.images?.[0] ?? null,
  };
}

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export class Tone3000 {
  private cache = new Map<string, { at: number; value: unknown }>();
  constructor(private ctx: ProviderContext) {}

  authorizeUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string; select?: boolean; gears?: string[]; format?: 'nam' | 'ir' }): string {
    const u = new URL(`${T3K_SITE}/api/v1/oauth/authorize`);
    u.searchParams.set('client_id', o.clientId);
    u.searchParams.set('redirect_uri', o.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('code_challenge', o.challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', o.state);
    if (o.select) {
      u.searchParams.set('prompt', 'select_tone');
      u.searchParams.set('preview', 'true');
      u.searchParams.set('menubar', 'true');
      if (o.gears?.length) u.searchParams.set('gears', o.gears.join('_'));
      if (o.format) u.searchParams.set('format', o.format);
    }
    return u.href;
  }

  async token(body: Record<string, string>): Promise<T3kSession> {
    let res: Response;
    try {
      res = await this.ctx.fetch(`${API}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(20000) });
    } catch {
      throw new ProviderError('Couldn’t reach TONE3000.');
    }
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !j.access_token) throw new ProviderError(j.error === 'invalid_grant' ? 'Your TONE3000 sign-in expired. Connect again.' : `TONE3000 sign-in failed: ${j.error_description || j.error || res.status}`, res.status);
    return { access: j.access_token, refresh: j.refresh_token ?? '', expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000 };
  }

  /** GET with the user's token; refreshes once on 401 through `refresh` */
  async get<T>(path: string, session: T3kSession, refresh: () => Promise<T3kSession>, cacheMs = 0): Promise<T> {
    const key = `${session.access.slice(-12)}:${path}`;
    const hit = cacheMs ? this.cache.get(key) : undefined;
    if (hit && Date.now() - hit.at < cacheMs) return hit.value as T;
    let s = session;
    if (s.expiresAt < Date.now() && s.refresh) s = await refresh();
    let res = await this.raw(`${API}${path}`, s.access);
    if (res.status === 401 && s.refresh) { s = await refresh(); res = await this.raw(`${API}${path}`, s.access); }
    if (res.status === 401) throw Object.assign(new ProviderError('Connect your TONE3000 account again.', 401), { needsAuth: true });
    if (res.status === 403) throw new ProviderError('TONE3000 doesn’t allow this for your API key.', 403);
    if (res.status === 429) throw new ProviderError('TONE3000’s rate limit was reached; try again in a minute.', 429);
    if (!res.ok) throw new ProviderError(`TONE3000 answered ${res.status}.`, res.status);
    const v = (await res.json()) as T;
    if (cacheMs) this.cache.set(key, { at: Date.now(), value: v });
    return v;
  }

  private async raw(url: string, access: string): Promise<Response> {
    try {
      return await this.ctx.fetch(url, { headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    } catch {
      throw new ProviderError('Couldn’t reach TONE3000.');
    }
  }

  async list(q: NamSearchQuery, session: T3kSession, refresh: () => Promise<T3kSession>): Promise<{ results: NamSearchResult[]; page: number; pages: number; total: number }> {
    const list = q.list ?? 'trending';
    const gears = [...new Set(q.types.map((t) => GEAR_FOR_TYPE[t]).filter(Boolean))] as string[];
    const params = new URLSearchParams();
    // the bounded lists take one gear value; with several types, filter afterwards
    if (gears.length === 1) params.set('gear', gears[0]);
    let tones: T3kTone[];
    let page = 1, pages = 1, total = 0;
    if (list === 'trending' || list === 'latest') {
      const r = await this.get<{ data: T3kTone[] }>(`/tones/${list}${params.size ? `?${params}` : ''}`, session, refresh, 60_000);
      tones = r.data ?? [];
      total = tones.length;
    } else {
      params.set('page', String(q.page ?? 1));
      params.set('page_size', '50');
      if (q.q.trim()) params.set('query', q.q.trim());
      const r = await this.get<Page<T3kTone>>(`/tones/${list}?${params}`, session, refresh, 30_000);
      tones = r.data ?? [];
      page = r.page ?? 1; pages = r.total_pages ?? 1; total = r.total ?? tones.length;
    }
    const words = list === 'trending' || list === 'latest' ? q.q.toLowerCase().split(/\s+/).filter(Boolean) : [];
    const results = tones.map(toneToResult).filter((r) => {
      if (q.types.length && !q.types.includes(r.type)) return false;
      if (!matchesAny(q.tones, r.tones) || !matchesAny(q.genres, r.genres)) return false;
      if (words.length) { const hay = `${r.title} ${r.tags.join(' ')} ${r.makes.join(' ')} ${r.creator ?? ''}`.toLowerCase(); if (!words.every((w) => hay.includes(w))) return false; }
      return true;
    });
    return { results, page, pages, total };
  }

  async tone(id: string, session: T3kSession, refresh: () => Promise<T3kSession>): Promise<{ tone: NamSearchResult; models: NamSearchModel[]; raw: T3kModel[] }> {
    const t = await this.get<T3kTone>(`/tones/${encodeURIComponent(id)}`, session, refresh, 60_000);
    const m = await this.get<Page<T3kModel>>(`/models?tone_id=${encodeURIComponent(id)}&page_size=300`, session, refresh, 60_000);
    const raw = m.data ?? [];
    return { tone: toneToResult(t), models: raw.map((x) => ({ id: String(x.id), name: x.name, size: x.size, architecture: x.architecture_version ?? null })), raw };
  }

  async downloadModel(model: T3kModel, session: T3kSession): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await this.ctx.fetch(model.model_url, { headers: { Authorization: `Bearer ${session.access}` }, signal: AbortSignal.timeout(120000) });
    } catch {
      throw new ProviderError('Couldn’t download the model from TONE3000.');
    }
    if (!res.ok) throw new ProviderError(`TONE3000 answered ${res.status} for “${model.name}”.`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
}

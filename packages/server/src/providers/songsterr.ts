import { classifyInstrument, tuningName, type Instrument, type OnlineResult } from '@fretforge/shared';
import { getHtml, getJson, ProviderError, request, slug, type ProviderContext } from './http';
import { songsterrToScore, type SongsterrMeta, type SongsterrTrackMeta, type SongsterrTrackPayload } from './songsterrConvert';
import type * as alphaTab from '@coderline/alphatab';

const SITE = 'https://www.songsterr.com';

interface SearchTrack { instrumentId?: number; instrument?: string; name?: string; title?: string; tuning?: number[]; isDrums?: boolean; isVocalTrack?: boolean }
interface SearchItem {
  songId?: number; id?: number; artist?: string | { name?: string }; title?: string; tracks?: SearchTrack[]; defaultTrack?: number;
  hasChords?: boolean; hasPlayer?: boolean;
}

export function songsterrUrl(id: number | string, artist: string, title: string): string {
  return `${SITE}/a/wsa/${slug(artist)}-${slug(title)}-tab-s${id}`;
}

function artistName(a: SearchItem['artist']): string {
  return typeof a === 'string' ? a : a?.name ?? '';
}

function trackInstrument(t: SearchTrack): Instrument {
  return classifyInstrument({ name: t.name || t.title || t.instrument, program: t.instrumentId === 1024 ? undefined : t.instrumentId, isPercussion: t.instrumentId === 1024 || t.isDrums, tuning: t.tuning, strings: t.tuning?.length });
}

export function mapSearchItems(items: SearchItem[]): OnlineResult[] {
  return items.flatMap((it) => {
    const id = it.songId ?? it.id;
    if (!id || !it.title) return [];
    const artist = artistName(it.artist);
    const tracks = it.tracks ?? [];
    const instruments = [...new Set(tracks.map(trackInstrument))];
    const main = tracks[it.defaultTrack ?? 0] ?? tracks.find((t) => trackInstrument(t) === 'guitar');
    return [{
      source: 'songsterr' as const,
      ref: String(id),
      title: it.title,
      artist,
      variant: tracks.length ? `${tracks.length} track${tracks.length === 1 ? '' : 's'}` : 'Tab',
      instruments,
      tuningName: main?.tuning?.length ? tuningName(main.tuning) : null,
      url: songsterrUrl(id, artist, it.title),
    }];
  });
}

export async function searchSongsterr(ctx: ProviderContext, q: string): Promise<OnlineResult[]> {
  const pattern = encodeURIComponent(q.trim());
  try {
    const items = await getJson<SearchItem[]>(ctx, `${SITE}/api/songs?size=50&from=0&pattern=${pattern}`, `${SITE}/`);
    return mapSearchItems(Array.isArray(items) ? items : []);
  } catch (e) {
    // Older endpoint, still answered on some mirrors
    if (e instanceof ProviderError && e.status === 404) {
      const items = await getJson<SearchItem[]>(ctx, `${SITE}/a/ra/songs.json?pattern=${pattern}`, `${SITE}/`);
      return mapSearchItems(Array.isArray(items) ? items : []);
    }
    throw e;
  }
}

// CDN hosts used by Songsterr's player for revision JSON (from their client bundle).
const CDN_STAGE = 'd3d3l6a6rcgkaf';
const CDN_LIST = ['dqsljvtekg760', 'd34shlm8p2ums2', 'd3cqchs6g3b5ew'];
const CDN_LEGACY = ['d3rrfvx08uyjp1', 'dodkcbujl0ebx', 'dj1usja78sinh'];

function trackUrls(meta: SongsterrMeta, partId: number): string[] {
  if (meta.image && meta.image.endsWith('-stage')) return [`https://${CDN_STAGE}.cloudfront.net/${meta.songId}/${meta.revisionId}/${meta.image}/${partId}.json`];
  if (meta.image) return CDN_LIST.map((c) => `https://${c}.cloudfront.net/${meta.songId}/${meta.revisionId}/${meta.image}/${partId}.json`);
  return CDN_LEGACY.map((c) => `https://${c}.cloudfront.net/part/${meta.revisionId}/${partId}`);
}

async function fetchTrack(ctx: ProviderContext, meta: SongsterrMeta, partId: number): Promise<SongsterrTrackPayload | null> {
  for (const url of trackUrls(meta, partId)) {
    const res = await request(ctx, url, 'json', `${SITE}/`).catch(() => null);
    if (!res || !res.ok) continue;
    const text = await res.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as SongsterrTrackPayload;
  }
  return null;
}

function normalizeMeta(raw: any, songId: number): SongsterrMeta {
  const cur = raw?.meta?.current ?? raw?.current ?? raw;
  if (!cur || !cur.revisionId) throw new ProviderError('Songsterr didn’t return tab data for this song.');
  const tracks: SongsterrTrackMeta[] = (cur.tracks ?? []).map((t: any, i: number) => ({
    partId: typeof t.partId === 'number' ? t.partId : i,
    instrumentId: t.instrumentId,
    title: t.title || t.name,
    name: t.name,
    tuning: t.tuning,
    isDrums: t.isDrums || t.instrumentId === 1024,
  }));
  return {
    songId: cur.songId ?? songId,
    revisionId: cur.revisionId,
    image: cur.image ?? null,
    title: cur.title ?? '',
    artist: typeof cur.artist === 'string' ? cur.artist : cur.artist?.name ?? '',
    tracks,
  };
}

async function fetchMeta(ctx: ProviderContext, songId: number): Promise<SongsterrMeta> {
  try {
    return normalizeMeta(await getJson(ctx, `${SITE}/api/meta/${songId}`, `${SITE}/`), songId);
  } catch (e) {
    // Fall back to the state JSON embedded in the tab page
    const html = await getHtml(ctx, `${SITE}/a/wsa/song-tab-s${songId}`);
    const m = /<script[^>]*id="state"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!m) throw e instanceof ProviderError ? e : new ProviderError('Couldn’t read the Songsterr page.');
    return normalizeMeta(JSON.parse(m[1]), songId);
  }
}

export interface FetchedSongsterr {
  score: alphaTab.model.Score;
  meta: SongsterrMeta;
  warnings: string[];
  url: string;
}

export async function fetchSongsterr(ctx: ProviderContext, ref: string): Promise<FetchedSongsterr> {
  const m = /s(\d+)(?:$|[/?#])/.exec(ref) || /^(\d+)$/.exec(ref.trim());
  const songId = Number(m ? m[1] : ref);
  if (!Number.isFinite(songId)) throw new ProviderError('That isn’t a Songsterr song id or link.');
  const meta = await fetchMeta(ctx, songId);
  const parts = await Promise.all(meta.tracks.map(async (t) => ({ meta: t, payload: await fetchTrack(ctx, meta, t.partId) })));
  const tracks = parts.filter((p): p is { meta: SongsterrTrackMeta; payload: SongsterrTrackPayload } => !!p.payload);
  if (!tracks.length) throw new ProviderError('Songsterr’s servers didn’t return any tracks for this tab. Try again in a minute.');
  const { score, warnings } = songsterrToScore({ meta, tracks });
  const missing = parts.length - tracks.length;
  if (missing) warnings.unshift(`${missing} track${missing === 1 ? '' : 's'} couldn’t be downloaded`);
  return { score, meta, warnings, url: songsterrUrl(songId, meta.artist, meta.title) };
}

export interface SongsterrVideo { videoId: string; points: number[]; feature: string | null }

/**
 * The YouTube videos Songsterr syncs with a tab, with the time each played bar starts.
 * Fails soft: a song without videos (or a site change) gives an empty list.
 */
export async function fetchSongsterrVideos(ctx: ProviderContext, songId: number, revisionId: number): Promise<SongsterrVideo[]> {
  try {
    const raw = await getJson<unknown>(ctx, `${SITE}/api/video-points/${songId}/${revisionId}/list`, `${SITE}/`);
    return parseSongsterrVideos(raw);
  } catch {
    return [];
  }
}

export function parseSongsterrVideos(raw: unknown): SongsterrVideo[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { videos?: unknown[] })?.videos) ? (raw as { videos: unknown[] }).videos : [];
  const out: SongsterrVideo[] = [];
  const seen = new Set<string>();
  for (const v of list as { videoId?: unknown; points?: unknown; feature?: unknown; status?: unknown }[]) {
    const id = typeof v?.videoId === 'string' ? v.videoId : '';
    if (!/^[\w-]{11}$/.test(id) || seen.has(id)) continue;
    if (v.status && v.status !== 'done') continue;
    const points = Array.isArray(v.points) ? v.points.map(Number).filter((n) => Number.isFinite(n) && n >= 0) : [];
    if (points.length < 2) continue;
    seen.add(id);
    out.push({ videoId: id, points, feature: typeof v.feature === 'string' ? v.feature : null });
  }
  // the full song first, then backing tracks, solos, playthroughs
  const rank = (f: string | null) => (f === null ? 0 : /backing/i.test(f) ? 1 : 2);
  return out.sort((a, b) => rank(a.feature) - rank(b.feature));
}

export async function fetchSongsterrRevision(ctx: ProviderContext, songId: number): Promise<number> {
  return (await fetchMeta(ctx, songId)).revisionId;
}

export const songsterrIds = (ref: string): number | null => {
  const m = /s(\d+)(?:$|[/?#])/.exec(ref) || /^(\d+)$/.exec(ref.trim());
  return m ? Number(m[1]) : null;
};

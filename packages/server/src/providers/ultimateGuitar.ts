import type { Instrument, OnlineResult, TextTab } from '@fretforge/shared';
import { decodeEntities, getHtml, ProviderError, type ProviderContext } from './http';

const SITE = 'https://www.ultimate-guitar.com';

/** Free, text-based types we can show. Pro, Official and Guitar Pro downloads need a paid account. */
const FREE_TYPES: Record<string, Instrument> = {
  Chords: 'guitar',
  Tabs: 'guitar',
  Tab: 'guitar',
  'Bass Tabs': 'bass',
  'Bass Tab': 'bass',
  'Ukulele Chords': 'other',
  'Drum Tabs': 'drums',
  'Drum Tab': 'drums',
};

interface UgResult {
  id?: number; song_name?: string; artist_name?: string; type?: string; part?: string; version?: number;
  votes?: number; rating?: number; tab_url?: string; marketing_type?: string; tab_access_type?: string; tonality_name?: string;
}

/** Pull the JSON blob UG renders into <div class="js-store" data-content="...">. */
export function extractStore(html: string): any {
  const m = /class="js-store"\s+data-content="([^"]*)"/.exec(html) || /data-content="([^"]*)"\s+class="js-store"/.exec(html);
  if (!m) {
    if (/challenge-platform|cf-chl|Just a moment/i.test(html)) throw new ProviderError('Ultimate Guitar asked for a browser check. Try again from the desktop app.');
    throw new ProviderError('Couldn’t read the Ultimate Guitar page. The site layout may have changed.');
  }
  return JSON.parse(decodeEntities(m[1]));
}

export function mapUgResults(results: UgResult[]): OnlineResult[] {
  const out: OnlineResult[] = [];
  for (const r of results) {
    const type = r.type ?? '';
    if (!(type in FREE_TYPES) || r.marketing_type || !r.tab_url || !r.song_name) continue;
    if (r.tab_access_type && r.tab_access_type !== 'public') continue;
    out.push({
      source: 'ultimate-guitar',
      ref: r.tab_url,
      title: r.song_name,
      artist: r.artist_name ?? '',
      variant: `${type}${r.part ? ' ' + r.part : ''}${r.version && r.version > 1 ? ` (ver ${r.version})` : ''}`,
      instruments: [FREE_TYPES[type]],
      rating: r.rating ? Math.round(r.rating * 10) / 10 : undefined,
      votes: r.votes,
      url: r.tab_url,
    });
  }
  return out;
}

export async function searchUltimateGuitar(ctx: ProviderContext, q: string): Promise<OnlineResult[]> {
  const html = await getHtml(ctx, `${SITE}/search.php?search_type=title&value=${encodeURIComponent(q.trim())}`);
  const store = extractStore(html);
  const results: UgResult[] = store?.store?.page?.data?.results ?? [];
  return mapUgResults(results);
}

export interface FetchedUg {
  tab: TextTab;
  title: string;
  artist: string;
  type: string;
  instruments: Instrument[];
  url: string;
  rating?: number;
  votes?: number;
}

export function parseUgTabPage(store: any, url: string): FetchedUg {
  const data = store?.store?.page?.data;
  const content: string | undefined = data?.tab_view?.wiki_tab?.content;
  if (!content) throw new ProviderError('This Ultimate Guitar page has no free text tab (it may be Pro or Official only).');
  const tab = data.tab ?? {};
  const meta = data.tab_view?.meta ?? {};
  const capoRaw = meta.capo ?? tab.capo ?? 0;
  const type: string = tab.type ?? 'Tabs';
  return {
    tab: {
      content,
      capo: Number(capoRaw) || 0,
      tuning: meta.tuning?.value ?? meta.tuning?.name ?? null,
      key: tab.tonality_name || meta.tonality || null,
      shapes: {},
      type,
    },
    title: tab.song_name ?? 'Untitled',
    artist: tab.artist_name ?? '',
    type,
    instruments: [FREE_TYPES[type] ?? 'guitar'],
    url,
    rating: tab.rating,
    votes: tab.votes,
  };
}

export async function fetchUltimateGuitar(ctx: ProviderContext, url: string): Promise<FetchedUg> {
  if (!/^https:\/\/(tabs|www)\.ultimate-guitar\.com\//.test(url)) throw new ProviderError('That isn’t an Ultimate Guitar tab link.');
  const html = await getHtml(ctx, url);
  return parseUgTabPage(extractStore(html), url);
}

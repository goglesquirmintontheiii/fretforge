// GuitarTabs.cc: a large archive of free text tabs and chord sheets. Search goes through the
// site's search page; tab pages hold the tab in a <pre> block.
import { markChords, type Instrument, type OnlineResult, type TextTab } from '@fretforge/shared';
import { decodeEntities, getHtml, ProviderError, type ProviderContext } from './http';

const SITE = 'https://www.guitartabs.cc';

const TYPES: Record<string, { label: string; instrument: Instrument }> = {
  tab: { label: 'Tab', instrument: 'guitar' },
  crd: { label: 'Chords', instrument: 'guitar' },
  btab: { label: 'Bass Tab', instrument: 'bass' },
  dtab: { label: 'Drum Tab', instrument: 'drums' },
  utab: { label: 'Ukulele', instrument: 'other' },
};

const TAB_LINK = /href="((?:https?:\/\/(?:www\.)?guitartabs\.cc)?\/tabs\/[a-z0-9]\/([a-z0-9_]+)\/([a-z0-9_]+?)_(tab|crd|btab|dtab|utab)(?:_ver_(\d+))?\.html)"[^>]*>([\s\S]*?)<\/a>/gi;

const titleCase = (slug: string) => slug.replace(/_+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
const strip = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** every tab link on a page (search results, artist pages, top lists) */
export function parseGuitarTabsLinks(html: string): OnlineResult[] {
  const out = new Map<string, OnlineResult>();
  for (const m of html.matchAll(TAB_LINK)) {
    const [, href, artistSlug, songSlug, type, ver, inner] = m;
    const url = href.startsWith('http') ? href.replace(/^http:/, 'https:') : SITE + href;
    if (out.has(url)) continue;
    const t = TYPES[type.toLowerCase()];
    const text = strip(inner);
    const acoustic = /_acoustic$/.test(songSlug);
    const songName = titleCase(songSlug.replace(/_acoustic$/, ''));
    out.set(url, {
      source: 'guitartabs', ref: url, url,
      title: text && !/^(tab|chords|bass|drums?|ver(sion)? ?\d*)$/i.test(text) && text.length < 120 ? text.replace(/\s+(chords|tab|bass tab|drum tab)( ver \d+)?$/i, '') : songName,
      artist: titleCase(artistSlug),
      variant: `${t.label}${acoustic ? ' (acoustic)' : ''}${ver ? ` (ver ${ver})` : ''}`,
      instruments: [t.instrument],
      kind: acoustic ? 'acoustic' : undefined,
    });
  }
  return [...out.values()];
}

export async function searchGuitarTabs(ctx: ProviderContext, q: string): Promise<OnlineResult[]> {
  const enc = encodeURIComponent(q.trim());
  // the form searches songs or artists; ask for both and merge
  const pages = await Promise.allSettled([
    getHtml(ctx, `${SITE}/search.php?tabtype=any&band=&song=${enc}`),
    getHtml(ctx, `${SITE}/search.php?tabtype=any&band=${enc}&song=`),
  ]);
  const ok = pages.filter((p): p is PromiseFulfilledResult<string> => p.status === 'fulfilled');
  if (!ok.length) throw (pages[0] as PromiseRejectedResult).reason ?? new ProviderError('GuitarTabs.cc didn’t answer.');
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const seen = new Set<string>();
  const results: OnlineResult[] = [];
  for (const p of ok) for (const r of parseGuitarTabsLinks(p.value)) {
    if (seen.has(r.ref)) continue;
    seen.add(r.ref);
    const hay = `${r.title} ${r.artist}`.toLowerCase();
    // search pages also link "top tabs"; keep what matches the query
    if (words.length && !words.some((w) => hay.includes(w))) continue;
    results.push(r);
  }
  return results.slice(0, 60);
}

export interface FetchedText { tab: TextTab; title: string; artist: string; type: string; instruments: Instrument[]; url: string }

export function parseGuitarTabsPage(html: string, url: string): FetchedText {
  const blocks = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map((m) => decodeEntities(m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')));
  const content = blocks.sort((a, b) => b.length - a.length)[0]?.replace(/ /g, ' ').trim();
  if (!content || content.length < 20) throw new ProviderError('This GuitarTabs.cc page has no tab text Fretforge can read.');
  const titleTag = strip(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  const tm = /^(.*?)\s+-\s+(.*?)\s+(?:Chords\s*&\s*Tabs|Tab|Chords|Bass Tab|Drum Tab)\b/i.exec(titleTag);
  const m = /\/tabs\/[a-z0-9]\/([a-z0-9_]+)\/([a-z0-9_]+?)_(tab|crd|btab|dtab|utab)(?:_ver_\d+)?\.html/i.exec(url);
  const type = TYPES[(m?.[3] ?? 'tab').toLowerCase()] ?? TYPES.tab;
  const capo = Number(/\bcapo\s*(?:on|at)?\s*(\d{1,2})/i.exec(content)?.[1] ?? 0) || 0;
  const tuning = /\btuning\s*[:=-]\s*([^\n]{2,40})/i.exec(content)?.[1]?.trim() ?? null;
  return {
    tab: { content: markChords(content), capo, tuning, key: null, shapes: {}, type: type.label },
    title: tm?.[2]?.trim() || titleCase(m?.[2] ?? 'Untitled'),
    artist: tm?.[1]?.trim() || titleCase(m?.[1] ?? ''),
    type: type.label,
    instruments: [type.instrument],
    url,
  };
}

export async function fetchGuitarTabs(ctx: ProviderContext, url: string): Promise<FetchedText> {
  if (!/^https?:\/\/(www\.)?guitartabs\.cc\/tabs\//.test(url)) throw new ProviderError('That isn’t a GuitarTabs.cc tab link.');
  return parseGuitarTabsPage(await getHtml(ctx, url.replace(/^http:/, 'https:')), url);
}

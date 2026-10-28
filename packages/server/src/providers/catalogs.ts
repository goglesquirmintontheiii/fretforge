// Paid catalogs Fretforge can only point to: Guitar Pro's mySongBook (official tabs that need a
// Guitar Pro subscription) and guitar.ch (PDF transcriptions behind a subscription). Results
// open on the site; nothing is downloaded. Both sites have no search API, so their public
// indexes are read and cached for a day.
import type { OnlineResult } from '@fretforge/shared';
import { decodeEntities, getHtml, type ProviderContext } from './http';

const GP = 'https://www.guitar-pro.com';
const CH = 'https://www.guitar.ch/en-us/guitar/tab/tab.html';
const DAY = 24 * 3600_000;

const strip = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

let gpArtists: { at: number; list: { id: string; slug: string; name: string }[] } | null = null;
const gpPages = new Map<string, { at: number; tabs: OnlineResult[] }>();

export function parseGpArtists(html: string): { id: string; slug: string; name: string }[] {
  const out = new Map<string, { id: string; slug: string; name: string }>();
  for (const m of html.matchAll(/href="(?:https:\/\/www\.guitar-pro\.com)?\/tabs\/artists\/(\d+)-([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const name = strip(m[3]);
    if (name && !out.has(m[1])) out.set(m[1], { id: m[1], slug: m[2], name });
  }
  return [...out.values()];
}

export function parseGpTabs(html: string, artist: string): OnlineResult[] {
  const out = new Map<string, OnlineResult>();
  for (const m of html.matchAll(/href="(?:https:\/\/www\.guitar-pro\.com)?\/tabs\/t\/(\d+)-([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = `${GP}/tabs/t/${m[1]}-${m[2]}`;
    if (out.has(url)) continue;
    const text = strip(m[3]);
    const title = m[2].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const variant = text.toLowerCase().startsWith(title.toLowerCase()) ? text.slice(title.length).replace(/^[\s\-–:]+/, '') : text;
    out.set(url, {
      source: 'guitar-pro', ref: url, url, title, artist, variant: variant || 'Official tab', instruments: /bass/i.test(variant) ? ['bass'] : /drum/i.test(variant) ? ['drums'] : ['guitar'],
      openable: false, note: 'Official mySongBook tab: plays in Guitar Pro with a subscription',
    });
  }
  return [...out.values()];
}

export async function searchGuitarPro(ctx: ProviderContext, q: string): Promise<OnlineResult[]> {
  if (!gpArtists || Date.now() - gpArtists.at > DAY) {
    const html = await getHtml(ctx, `${GP}/tabs/artists`);
    gpArtists = { at: Date.now(), list: parseGpArtists(html) };
  }
  const nq = norm(q);
  const words = nq.split(' ').filter(Boolean);
  // artists named in the query (whole name inside the query, or the query inside the name)
  const hits = gpArtists.list
    .map((a) => ({ a, n: norm(a.name) }))
    .filter(({ n }) => n && (nq.includes(n) || (nq.length >= 3 && n.includes(nq))))
    .sort((x, y) => y.n.length - x.n.length)
    .slice(0, 3);
  const results: OnlineResult[] = [];
  for (const { a, n } of hits) {
    const key = a.id;
    let page = gpPages.get(key);
    if (!page || Date.now() - page.at > DAY) {
      page = { at: Date.now(), tabs: parseGpTabs(await getHtml(ctx, `${GP}/tabs/artists/${a.id}-${a.slug}`), a.name) };
      gpPages.set(key, page);
      if (gpPages.size > 200) gpPages.delete(gpPages.keys().next().value!);
    }
    const rest = words.filter((w) => !n.split(' ').includes(w));
    results.push(...page.tabs.filter((t) => !rest.length || rest.every((w) => norm(t.title).includes(w))));
  }
  return results.slice(0, 40);
}

let chIndex: { at: number; list: OnlineResult[] } | null = null;

export function parseGuitarCh(html: string): OnlineResult[] {
  const out = new Map<string, OnlineResult>();
  for (const m of html.matchAll(/href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(m[1]);
    if (!/\.pdf(\?|$)|\/tab\/[^/]+\.html|tabulatur|tablature/i.test(href) || /\/tab\/tab\.html$/.test(href)) continue;
    const text = strip(m[2]);
    if (!text || text.length > 140) continue;
    const url = new URL(href, CH).href;
    // index entries read "Artist - Title" or "Title (Artist)"
    const dash = /^(.*?)\s+[-–]\s+(.*)$/.exec(text), paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(text);
    const [artist, title] = dash ? [dash[1], dash[2]] : paren ? [paren[2], paren[1]] : ['', text];
    out.set(url, { source: 'guitar-ch', ref: url, url, title, artist, variant: 'PDF transcription', instruments: /bass/i.test(text) ? ['bass'] : ['guitar'], openable: false, note: 'PDF transcription: needs a guitar.ch subscription' });
  }
  return [...out.values()];
}

export async function searchGuitarCh(ctx: ProviderContext, q: string): Promise<OnlineResult[]> {
  if (!chIndex || Date.now() - chIndex.at > DAY) chIndex = { at: Date.now(), list: parseGuitarCh(await getHtml(ctx, CH)) };
  const words = norm(q).split(' ').filter(Boolean);
  return chIndex.list.filter((r) => { const n = norm(`${r.artist} ${r.title}`); return words.every((w) => n.includes(w)); }).slice(0, 30);
}

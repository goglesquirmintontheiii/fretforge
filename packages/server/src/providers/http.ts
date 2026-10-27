export interface ProviderContext {
  fetch: typeof fetch;
  /**
   * Fetch a web page's HTML. The desktop app supplies one that falls back to a hidden
   * browser window when a site answers plain requests with a bot challenge.
   */
  fetchHtml?: (url: string) => Promise<string>;
  /** Plain fetch sends browser-like headers; Chromium's net.fetch sets its own. */
  browserHeaders?: boolean;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export function headersFor(ctx: ProviderContext, kind: 'json' | 'html', referer?: string): Record<string, string> {
  if (ctx.browserHeaders === false) return referer ? { Referer: referer } : {};
  const h: Record<string, string> = {
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: kind === 'json' ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  if (referer) h.Referer = referer;
  return h;
}

export async function request(ctx: ProviderContext, url: string, kind: 'json' | 'html', referer?: string, timeoutMs = 15000): Promise<Response> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { headers: headersFor(ctx, kind, referer), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    throw new ProviderError(name === 'TimeoutError' || name === 'AbortError' ? 'The site took too long to answer.' : `Couldn’t reach ${new URL(url).host}. Check your internet connection.`);
  }
  return res;
}

export async function getJson<T>(ctx: ProviderContext, url: string, referer?: string): Promise<T> {
  const res = await request(ctx, url, 'json', referer);
  if (!res.ok) throw new ProviderError(`${new URL(url).host} answered ${res.status}`, res.status);
  return (await res.json()) as T;
}

export async function getHtml(ctx: ProviderContext, url: string): Promise<string> {
  if (ctx.fetchHtml) return ctx.fetchHtml(url);
  const res = await request(ctx, url, 'html');
  if (!res.ok) throw new ProviderError(`${new URL(url).host} answered ${res.status}`, res.status);
  return res.text();
}

const ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

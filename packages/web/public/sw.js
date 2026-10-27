// Fretforge service worker: cached app shell and assets, pinned songs for offline use.
const SHELL = 'ff-shell-v1';
const SONGS = 'ff-songs-v1';
const PRECACHE = ['/', '/index.html', '/icon.svg', '/manifest.webmanifest', '/engine/forge-dsp.wasm', '/soundfont/sonivox.sf2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('ff-shell-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // API: network first; pinned songs (and the last status/prefs) answer when offline
  if (url.pathname.startsWith('/api/')) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && /^\/api\/(status|prefs|offline)$/.test(url.pathname)) (await caches.open(SHELL)).put(req, res.clone());
        if (res.ok && /^\/api\/songs\/[^/]+(\/(file|text|audio))?$/.test(url.pathname)) {
          const songs = await caches.open(SONGS);
          if (await songs.match(req)) songs.put(req, res.clone());
        }
        return res;
      } catch (err) {
        const hit = (await caches.match(req, { ignoreSearch: false })) || (url.pathname === '/api/songs' ? await offlineList(url) : null);
        if (hit) return hit;
        return new Response(JSON.stringify({ error: 'You are offline. Songs you keep offline still open.' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
    })());
    return;
  }

  // app navigation: network first, cached shell when offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => { caches.open(SHELL).then((c) => c.put('/index.html', res.clone())); return res; }).catch(() => caches.match('/index.html')));
    return;
  }

  // static files: cache first, refresh in the background
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req);
    const net = fetch(req).then((res) => { if (res.ok && res.type === 'basic') cache.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || new Response('', { status: 504 });
  })());
});

/** The library list when offline: the pinned songs. */
async function offlineList(url) {
  const cache = await caches.open(SONGS);
  const keys = await cache.keys();
  const songs = [];
  for (const k of keys) {
    if (!/^\/api\/songs\/[^/]+$/.test(new URL(k.url).pathname)) continue;
    const r = await cache.match(k);
    try { songs.push(await r.json()); } catch { /* skip */ }
  }
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const list = q ? songs.filter((s) => (s.title + ' ' + s.artist).toLowerCase().includes(q)) : songs;
  return new Response(JSON.stringify({ songs: list, total: songs.length }), { headers: { 'content-type': 'application/json' } });
}

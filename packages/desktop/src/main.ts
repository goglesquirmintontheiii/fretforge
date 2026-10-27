import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type Session } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, VERSION, type FretforgeServer } from '@fretforge/server';

const SELFTEST = process.env.FRETFORGE_SELFTEST; // path for a screenshot; used by CI to check a packaged build
let server: FretforgeServer | null = null;
let win: BrowserWindow | null = null;
let origin = '';

if (!app.requestSingleInstanceLock() && !SELFTEST) {
  app.quit();
}
app.setName('Fretforge');

// ------------------------------------------------------------------ online fetching
// Tab sites see Chromium's real network stack (same TLS and headers as a browser).
// If a site answers with a bot check, the page is loaded in a hidden window, which can pass it.
let webSession: Session;
const challenge = (html: string) => /challenge-platform|cf-chl|Just a moment\.\.\.|Attention Required/i.test(html);

async function browserFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  headers.delete('User-Agent');
  return webSession.fetch(url, { ...init, headers });
}

async function loadInHiddenWindow(url: string): Promise<string> {
  const w = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { session: webSession, sandbox: true, contextIsolation: true } });
  try {
    await w.loadURL(url).catch(() => {});
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const html: string = await w.webContents.executeJavaScript('document.documentElement.outerHTML').catch(() => '');
      if (html && !challenge(html) && (/js-store|id="state"/.test(html) || html.length > 50_000)) return html;
      await new Promise((r) => setTimeout(r, 600));
    }
    throw new Error('The site kept showing a browser check. Open it once in your browser, then try again.');
  } finally {
    w.destroy();
  }
}

async function fetchHtml(url: string): Promise<string> {
  try {
    const res = await webSession.fetch(url);
    const text = await res.text();
    if (res.ok && !challenge(text)) return text;
  } catch { /* fall through to the hidden window */ }
  return loadInHiddenWindow(url);
}

// ------------------------------------------------------------------ window state
const stateFile = () => join(app.getPath('userData'), 'window.json');
function loadBounds(): Electron.Rectangle | undefined {
  try { return JSON.parse(readFileSync(stateFile(), 'utf8')); } catch { return undefined; }
}
function saveBounds() {
  if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
  try { writeFileSync(stateFile(), JSON.stringify(win.getBounds())); } catch { /* not important */ }
}

function resourcePath(...p: string[]) {
  return app.isPackaged ? join(process.resourcesPath, ...p) : join(__dirname, '..', 'resources', ...p);
}

async function start() {
  webSession = session.fromPartition('persist:fretforge-web');
  const dataDir = process.env.FRETFORGE_DATA || join(app.getPath('userData'), 'data');
  let libraryDir = process.env.FRETFORGE_LIBRARY;
  if (!libraryDir) {
    try { libraryDir = join(app.getPath('music'), 'Fretforge'); } catch { libraryDir = join(app.getPath('home'), 'Fretforge'); }
  }
  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(24).toString('hex');
  const staticDir = app.isPackaged ? join(process.resourcesPath, 'web') : join(__dirname, '..', '..', 'web', 'dist');

  try {
    server = await createServer(
      { dataDir, libraryDir, host: '127.0.0.1', port: 0, mode: 'desktop', desktopToken: token, staticDir, version: VERSION, seedDemos: true },
      { fetch: browserFetch as typeof fetch, fetchHtml, browserHeaders: false },
    );
  } catch (e) {
    dialog.showErrorBox('Fretforge couldn’t start', String((e as Error)?.stack || e));
    app.exit(1);
    return;
  }
  origin = new URL(server.url).origin;

  // the tuner needs the microphone; everything else stays denied
  const allowed = new Set(['media', 'fullscreen', 'clipboard-sanitized-write', 'wake-lock', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(wc.getURL().startsWith(origin) && allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => requestingOrigin === origin && allowed.has(permission));

  const bounds = loadBounds();
  win = new BrowserWindow({
    width: bounds?.width ?? 1360, height: bounds?.height ?? 880, x: bounds?.x, y: bounds?.y,
    minWidth: 420, minHeight: 500,
    show: true,
    backgroundColor: '#0f1116',
    title: 'Fretforge',
    autoHideMenuBar: true,
    icon: resourcePath('icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(origin)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
  await win.loadURL(`${server.url}/?token=${token}`);

  if (SELFTEST) {
    // Packaged-build check: the page must render the library from the bundled server.
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 500));
      ok = await win.webContents.executeJavaScript('document.querySelectorAll(".song").length > 0').catch(() => false);
    }
    const img = await win.webContents.capturePage();
    writeFileSync(SELFTEST, img.toPNG());
    console.log(ok ? 'SELFTEST OK' : 'SELFTEST FAILED: library did not render');
    await server.close();
    app.exit(ok ? 0 : 1);
  }
}

ipcMain.handle('ff:chooseFolder', async (_e, current?: string) => {
  const r = await dialog.showOpenDialog(win!, { title: 'Choose your library folder', defaultPath: current && existsSync(current) ? current : undefined, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
ipcMain.handle('ff:openExternal', (_e, url: string) => { if (/^https?:\/\//.test(url)) return shell.openExternal(url); });
ipcMain.handle('ff:showItemInFolder', (_e, path: string) => shell.showItemInFolder(path));

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { saveBounds(); server?.store.flush(); });

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'Fretforge', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'quit' }] },
  { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
]));

app.whenReady().then(start);

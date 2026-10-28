// yt-dlp (YouTube audio for recordings and AI tabs): found on the system, in the AI tools'
// Python environment, or installed by Fretforge with one click into its data folder. The
// one-click install downloads the official standalone build from yt-dlp's GitHub releases and
// checks it against the release's SHA-256 list before it is used.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface YtdlpStatus { found: boolean; path: string | null; how: 'app' | 'system' | 'python' | null; version?: string; canInstall: boolean; reason?: string }

const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

function asset(): string | null {
  const p = process.platform, a = process.arch;
  if (p === 'linux' && a === 'x64') return 'yt-dlp_linux';
  if (p === 'linux' && a === 'arm64') return 'yt-dlp_linux_aarch64';
  if (p === 'darwin') return 'yt-dlp_macos';
  if (p === 'win32') return 'yt-dlp.exe';
  return null;
}

export const appYtdlp = (dataDir: string) => join(dataDir, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function hasPythonModule(venv: string): boolean {
  const lib = join(venv, 'lib');
  if (!existsSync(lib)) return false;
  try { return readdirSync(lib).some((d) => existsSync(join(lib, d, 'site-packages', 'yt_dlp'))); } catch { return false; }
}

const versions = new Map<string, string>();
function version(path: string): string | undefined {
  if (versions.has(path)) return versions.get(path);
  const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 15000 });
  const v = r.status === 0 ? r.stdout.trim().split('\n')[0] : undefined;
  if (v) versions.set(path, v);
  return v;
}

export function ytdlpStatus(dataDir: string, venv: string): YtdlpStatus {
  const canInstall = !!asset();
  const app = appYtdlp(dataDir);
  if (existsSync(app)) return { found: true, path: app, how: 'app', version: version(app), canInstall };
  const sys = onPath(process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (sys) return { found: true, path: sys, how: 'system', version: version(sys), canInstall };
  if (hasPythonModule(venv)) return { found: true, path: null, how: 'python', canInstall };
  return { found: false, path: null, how: null, canInstall, reason: canInstall ? undefined : 'There is no standalone yt-dlp build for this system; install yt-dlp with your package manager.' };
}

export async function installYtdlp(dataDir: string, fetchFn: typeof fetch): Promise<YtdlpStatus> {
  const name = asset();
  if (!name) throw new Error('There is no standalone yt-dlp build for this system; install yt-dlp with your package manager.');
  const get = async (url: string) => {
    const res = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url.split('/').pop()}.`);
    return new Uint8Array(await res.arrayBuffer());
  };
  let sums: string, bin: Uint8Array;
  try {
    sums = new TextDecoder().decode(await get(`${RELEASE}/SHA2-256SUMS`));
    bin = await get(`${RELEASE}/${name}`);
  } catch (e) {
    throw new Error(`yt-dlp couldn’t be downloaded: ${(e as Error).message}`);
  }
  const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === name)?.[0];
  const got = createHash('sha256').update(bin).digest('hex');
  if (!want || want.toLowerCase() !== got) throw new Error('The downloaded yt-dlp didn’t match its published checksum, so it wasn’t installed.');
  const dest = appYtdlp(dataDir);
  mkdirSync(join(dataDir, 'bin'), { recursive: true });
  writeFileSync(dest + '.part', bin);
  chmodSync(dest + '.part', 0o755);
  renameSync(dest + '.part', dest);
  versions.delete(dest);
  const v = version(dest);
  if (!v) throw new Error('yt-dlp was downloaded but doesn’t run on this system.');
  return { found: true, path: dest, how: 'app', version: v, canInstall: true };
}

/** throws a 400 the web app turns into an "Install yt-dlp" button */
export function requireYtdlp(jobs: { ytdlpStatus(): YtdlpStatus }) {
  if (jobs.ytdlpStatus().found) return;
  throw Object.assign(new Error('yt-dlp isn’t installed. It downloads the audio from YouTube.'), { statusCode: 400, code: 'ff-ytdlp-missing' });
}

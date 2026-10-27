import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { OidcConfig } from './auth';

export interface ServerConfig {
  /** Where db.json, converted scores and caches live. */
  dataDir: string;
  /** Default watched library folder (can be changed in settings). */
  libraryDir: string;
  host: string;
  port: number;
  /** "desktop": single user behind a random token; "server": owner password + sessions. */
  mode: 'desktop' | 'server';
  /** Required on every request in desktop mode. */
  desktopToken?: string;
  /** Built web app to serve; omitted in dev (Vite serves it). */
  staticDir?: string;
  version: string;
  /** Override for outbound HTTP (Electron passes Chromium's net.fetch). */
  fetch?: typeof fetch;
  /** Seed demo songs into an empty library. */
  seedDemos?: boolean;
  log?: boolean;
  /** OIDC settings (server mode); defaults to FRETFORGE_OIDC_* env vars */
  oidc?: OidcConfig;
  oidcFetch?: typeof fetch;
  /** Python used by the AI worker; overrides the AI settings (FRETFORGE_PYTHON) */
  python?: string;
  /** Folder holding the AI worker scripts (ai/fretforge_ai.py) */
  aiDir?: string;
  /** Don't start queued AI jobs (tests) */
  jobsPaused?: boolean;
}

export const VERSION = '0.4.0';

export function configFromEnv(): ServerConfig {
  const dataDir = resolve(process.env.FRETFORGE_DATA || join(homedir(), '.local', 'share', 'fretforge'));
  return {
    dataDir,
    libraryDir: resolve(process.env.FRETFORGE_LIBRARY || join(dataDir, 'library')),
    host: process.env.FRETFORGE_HOST || '0.0.0.0',
    port: Number(process.env.FRETFORGE_PORT || process.env.PORT || 7700),
    mode: (process.env.FRETFORGE_MODE as 'desktop' | 'server') || 'server',
    staticDir: process.env.FRETFORGE_STATIC ? resolve(process.env.FRETFORGE_STATIC) : undefined,
    version: VERSION,
    seedDemos: process.env.FRETFORGE_DEMOS !== '0',
    log: process.env.FRETFORGE_LOG === '1',
    python: process.env.FRETFORGE_PYTHON || undefined,
    aiDir: process.env.FRETFORGE_AI_DIR ? resolve(process.env.FRETFORGE_AI_DIR) : undefined,
  };
}

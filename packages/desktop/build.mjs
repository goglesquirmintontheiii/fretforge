import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

// The main process bundles the whole server, so the packaged app needs no node_modules.
await build({
  entryPoints: { main: 'src/main.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  alias: { '@fretforge/server': '../server/src/index.ts' },
  // chokidar/fastify are ESM-friendly; import.meta.url only appears in code paths we don't use in CJS
  define: { 'import.meta.url': '__ffImportMetaUrl' },
  banner: { js: "const __ffImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  legalComments: 'external',
  logLevel: 'warning',
});
await build({
  entryPoints: { preload: 'src/preload.ts', t3kPreload: 'src/t3kPreload.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'warning',
});
mkdirSync('resources', { recursive: true });
copyFileSync('build/icon.png', 'resources/icon.png');
console.log('desktop bundle written to dist/');

import { build } from 'esbuild';

// One self-contained file for Docker and for the desktop app.
await build({
  entryPoints: { main: 'src/main.ts', index: 'src/index.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  legalComments: 'external',
  banner: { js: "import { createRequire as __ffCreateRequire } from 'node:module'; const require = __ffCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});
console.log('server bundle written to dist/');

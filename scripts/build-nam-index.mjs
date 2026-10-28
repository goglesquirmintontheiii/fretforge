// Builds the bundled metadata index for GitHub NAM collections (names, gear and tone info only;
// no model data). Run from a checkout made with:
//   git clone --filter=blob:none --no-checkout https://github.com/<owner>/<repo>.git <dir>
//   node scripts/build-nam-index.mjs <owner/repo> <dir> [more pairs...]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const out = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const repo = args[i], dir = args[i + 1];
  const files = execFileSync('git', ['-C', dir, 'ls-tree', '-r', '-l', 'HEAD'], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n').filter(Boolean).map((l) => { const m = /^\S+ blob (\S+)\s+(\d+)\t(.*)$/.exec(l); return m && { sha: m[1], size: Number(m[2]), path: m[3] }; })
    .filter((f) => f && /\.(nam|wav)$/i.test(f.path));
  for (const f of files) {
    const e = { repo, path: f.path, size: f.size };
    if (/\.nam$/i.test(f.path)) {
      try {
        const j = JSON.parse(execFileSync('git', ['-C', dir, 'cat-file', '-p', f.sha], { encoding: 'utf8', maxBuffer: 256 << 20 }));
        const m = j.metadata ?? {};
        Object.assign(e, {
          name: m.name || undefined, modeledBy: m.modeled_by || undefined, gearType: m.gear_type || undefined, gearMake: m.gear_make || undefined,
          gearModel: m.gear_model || undefined, toneType: m.tone_type || undefined, architecture: j.architecture, version: j.version,
        });
      } catch (err) { e.error = String(err.message).slice(0, 80); }
    }
    out.push(e);
  }
  console.error(`${repo}: ${files.length} files`);
}
writeFileSync(new URL('../packages/server/src/providers/namIndex.json', import.meta.url), JSON.stringify({ builtAt: new Date().toISOString().slice(0, 10), files: out }));

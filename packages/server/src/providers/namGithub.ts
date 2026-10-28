// Free NAM models in GitHub repositories (for example the community collection
// pelennor2170/NAM_models). The file list comes from the GitHub API (cached for 12 hours) or,
// when GitHub can't be reached, from the bundled index; tags come from file names.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { guessGenres, guessRole, guessTones, matchesAny, roleToType, type NamSearchQuery, type NamSearchResult } from '@fretforge/shared';
import { ProviderError, type ProviderContext } from './http';
import bundled from './namIndex.json';

interface IndexFile { repo: string; path: string; size: number; name?: string; modeledBy?: string; gearType?: string; gearMake?: string; gearModel?: string; toneType?: string; architecture?: string }
interface RepoIndex { repo: string; fetchedAt: number; files: IndexFile[] }

const TTL = 12 * 3600_000;

export function parseRepo(spec: string): { owner: string; repo: string; sub: string } | null {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree\/[^/]+\/)?(.*))?\/?$/.exec(spec.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], sub: (m[3] ?? '').replace(/\/+$/, '') };
}

export class GithubNamSource {
  private mem = new Map<string, RepoIndex>();
  constructor(private ctx: ProviderContext, private cacheDir: string) {}

  private cacheFile(repo: string) { return join(this.cacheDir, `nam-index-${repo.replace(/[^\w.-]+/g, '_')}.json`); }

  async index(spec: string): Promise<IndexFile[]> {
    const p = parseRepo(spec);
    if (!p) throw new ProviderError(`“${spec}” isn’t a GitHub repository (use owner/repo).`);
    const key = `${p.owner}/${p.repo}`;
    let idx = this.mem.get(key);
    if (!idx && existsSync(this.cacheFile(key))) {
      try { idx = JSON.parse(readFileSync(this.cacheFile(key), 'utf8')) as RepoIndex; this.mem.set(key, idx); } catch { /* refetch */ }
    }
    if (!idx || Date.now() - idx.fetchedAt > TTL) {
      try {
        idx = await this.fetchTree(p.owner, p.repo);
        this.mem.set(key, idx);
        try { writeFileSync(this.cacheFile(key), JSON.stringify(idx)); } catch { /* cache is optional */ }
      } catch (e) {
        if (!idx) {
          const files = (bundled as { files: IndexFile[] }).files.filter((f) => f.repo === key);
          if (!files.length) throw e;
          idx = { repo: key, fetchedAt: 0, files };
        }
      }
    }
    // the bundled index has gear metadata the tree doesn't; merge it in
    const meta = new Map((bundled as { files: IndexFile[] }).files.filter((f) => f.repo === key).map((f) => [f.path, f]));
    return idx.files
      .filter((f) => !p.sub || f.path.startsWith(p.sub + '/'))
      .map((f) => ({ ...meta.get(f.path), ...f }));
  }

  private async fetchTree(owner: string, repo: string): Promise<RepoIndex> {
    let res: Response;
    try {
      res = await this.ctx.fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) });
    } catch {
      throw new ProviderError('Couldn’t reach GitHub.');
    }
    if (res.status === 404) throw new ProviderError(`GitHub has no public repository ${owner}/${repo}.`, 404);
    if (res.status === 403 || res.status === 429) throw new ProviderError('GitHub’s rate limit was reached; try again in an hour.', res.status);
    if (!res.ok) throw new ProviderError(`GitHub answered ${res.status}.`, res.status);
    const j = (await res.json()) as { tree?: { path: string; type: string; size?: number }[] };
    const files = (j.tree ?? []).filter((t) => t.type === 'blob' && /\.(nam|wav)$/i.test(t.path)).map((t) => ({ repo: `${owner}/${repo}`, path: t.path, size: t.size ?? 0 }));
    return { repo: `${owner}/${repo}`, fetchedAt: Date.now(), files };
  }

  async search(specs: string[], q: NamSearchQuery): Promise<NamSearchResult[]> {
    const words = q.q.toLowerCase().split(/\s+/).filter(Boolean);
    const out: NamSearchResult[] = [];
    const errors: string[] = [];
    for (const spec of specs) {
      let files: IndexFile[];
      try { files = await this.index(spec); } catch (e) { errors.push((e as Error).message); continue; }
      for (const f of files) {
        const r = toResult(f);
        const hay = `${r.title} ${f.path} ${r.makes.join(' ')} ${r.tags.join(' ')}`.toLowerCase();
        if (words.length && !words.every((w) => hay.includes(w))) continue;
        if (q.types.length && !q.types.includes(r.type)) continue;
        if (!matchesAny(q.tones, r.tones) || !matchesAny(q.genres, r.genres)) continue;
        out.push(r);
      }
    }
    if (!out.length && errors.length) throw new ProviderError(errors[0]);
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  /** downloads one file: id is "<owner>/<repo>:<path>" */
  async download(id: string): Promise<{ name: string; bytes: Uint8Array; url: string; repo: string; path: string }> {
    const i = id.indexOf(':');
    const repo = id.slice(0, i), path = id.slice(i + 1);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !path || path.includes('..')) throw new ProviderError('That isn’t a GitHub model id.');
    const url = `https://raw.githubusercontent.com/${repo}/HEAD/${path.split('/').map(encodeURIComponent).join('/')}`;
    let res: Response;
    try { res = await this.ctx.fetch(url, { signal: AbortSignal.timeout(60000) }); } catch { throw new ProviderError('Couldn’t reach GitHub.'); }
    if (!res.ok) throw new ProviderError(`GitHub answered ${res.status} for that file.`, res.status);
    return { name: path.split('/').pop() ?? path, bytes: new Uint8Array(await res.arrayBuffer()), url: `https://github.com/${repo}/blob/HEAD/${path}`, repo, path };
  }
}

function toResult(f: IndexFile): NamSearchResult {
  const file = f.path.split('/').pop() ?? f.path;
  const title = (f.name || file.replace(/\.(nam|wav)$/i, '')).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const kind = /\.wav$/i.test(f.path) ? 'ir' : 'nam';
  const text = `${title} ${f.path} ${f.gearMake ?? ''} ${f.gearModel ?? ''}`;
  const role = kind === 'ir' ? 'cab' : guessRole(f.gearType, text);
  const tones = kind === 'ir' ? [] : guessTones(text, f.toneType);
  // the community collection starts names with the contributor ("Helga B 6505+ ...")
  const contributor = /^([A-Z][a-z]+ [A-Z])\b/.exec(file)?.[1];
  const [owner] = f.repo.split('/');
  return {
    source: 'github', id: `${f.repo}:${f.path}`, title, creator: f.modeledBy || contributor || owner,
    url: `https://github.com/${f.repo}/blob/HEAD/${f.path.split('/').map(encodeURIComponent).join('/')}`,
    type: roleToType(role, kind), tags: [f.architecture, f.repo].filter(Boolean) as string[], tones, genres: guessGenres(text, tones),
    makes: [f.gearMake, f.gearModel].filter(Boolean) as string[], modelCount: 1,
  };
}

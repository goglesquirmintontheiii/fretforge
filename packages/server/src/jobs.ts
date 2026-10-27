// Background AI jobs (stem separation, alignment, YouTube audio, NAM training).
//
// Jobs run one at a time in a Python worker (ai/fretforge_ai.py). The worker prints one JSON
// object per line: {"progress": 0.4, "message": "..."} while working and {"result": {...}} or
// {"error": "..."} at the end. Everything here fails soft: a missing Python or package turns into
// a readable message on the job, never a crash.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AudioAsset, Job, JobKind, StemName } from '@fretforge/shared';
import type { ServerConfig } from './config';
import { newId, type Store } from './store';

const here = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));

export interface AiStatus { available: boolean; device: string | null; reason?: string }

export interface JobHandlers {
  /** called when a job produced files the server should register */
  onResult?: (job: Job) => void;
}

function findAiDir(cfg: ServerConfig): string | null {
  const candidates = [
    cfg.aiDir,
    process.env.FRETFORGE_AI_DIR,
    join(process.cwd(), 'ai'),
    resolve(here, '..', '..', '..', 'ai'),
    resolve(here, '..', '..', 'ai'),
    resolve(here, '..', 'ai'),
    (process as { resourcesPath?: string }).resourcesPath ? join((process as { resourcesPath?: string }).resourcesPath!, 'ai') : undefined,
  ];
  for (const c of candidates) if (c && existsSync(join(c, 'fretforge_ai.py'))) return c;
  return null;
}

export class JobRunner {
  private current: { job: Job; proc: ChildProcess } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private aiStatus: AiStatus = { available: false, device: null, reason: 'Not checked yet' };
  private stopped = false;
  readonly aiDir: string | null;
  handlers: JobHandlers = {};

  constructor(private store: Store, private cfg: ServerConfig) {
    this.aiDir = findAiDir(cfg);
  }

  /** The Python interpreter to use: env/config, the managed venv, or the setting. */
  python(): string {
    if (this.cfg.python) return this.cfg.python;
    const setting = this.store.prefs().ai.python;
    if (setting) return existsSync(join(setting, 'bin', 'python')) ? join(setting, 'bin', 'python') : setting;
    const venv = join(this.cfg.dataDir, 'ai-venv', 'bin', 'python');
    if (existsSync(venv)) return venv;
    return 'python3';
  }

  get venvDir() { return join(this.cfg.dataDir, 'ai-venv'); }

  status(): AiStatus { return this.aiStatus; }

  refreshStatus() {
    if (!this.aiDir) { this.aiStatus = { available: false, device: null, reason: 'The AI worker scripts are missing from this install.' }; return; }
    try {
      const r = spawnSync(this.python(), [join(this.aiDir, 'fretforge_ai.py'), 'probe'], { encoding: 'utf8', timeout: 60_000 });
      if (r.error) { this.aiStatus = { available: false, device: null, reason: 'Python was not found. Set up the AI tools in Settings.' }; return; }
      const last = (r.stdout || '').trim().split('\n').pop() || '{}';
      const j = JSON.parse(last) as { ok?: boolean; device?: string; missing?: string[] };
      this.aiStatus = j.ok
        ? { available: true, device: j.device ?? 'cpu' }
        : { available: false, device: j.device ?? null, reason: j.missing?.length ? `Missing Python packages: ${j.missing.join(', ')}. Set up the AI tools in Settings.` : 'The AI tools are not ready.' };
    } catch {
      this.aiStatus = { available: false, device: null, reason: 'The AI tools could not be checked.' };
    }
  }

  start() {
    // probing imports torch, which takes a few seconds: do it off the startup path
    setTimeout(() => { if (!this.stopped) this.refreshStatus(); }, 1500).unref();
    this.timer = setInterval(() => this.tick(), 2000);
    this.timer.unref();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.current?.proc.kill('SIGTERM');
  }

  add(kind: JobKind | 'setup', label: string, params: Record<string, unknown>, opts: { songId?: string; audioId?: string; createdBy: string | null; scheduled?: boolean }): Job {
    const j: Job = {
      id: newId(), kind: kind as JobKind, state: 'queued', label, progress: 0, message: opts.scheduled ? 'Waiting for the idle window' : 'Waiting',
      createdAt: Date.now(), createdBy: opts.createdBy, songId: opts.songId, audioId: opts.audioId, scheduled: opts.scheduled, params,
    };
    this.store.putJob(j);
    setImmediate(() => this.tick());
    return j;
  }

  cancel(id: string) {
    const j = this.store.job(id);
    if (!j) return;
    if (this.current?.job.id === id) this.current.proc.kill('SIGTERM');
    if (j.state === 'queued' || j.state === 'running') {
      j.state = 'cancelled';
      j.finishedAt = Date.now();
      j.message = 'Cancelled';
      this.store.putJob(j);
    }
  }

  inIdleWindow(now = new Date()): boolean {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(this.store.prefs().ai.idleWindow || '');
    if (!m) return true;
    const mins = now.getHours() * 60 + now.getMinutes();
    const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
    return a <= b ? mins >= a && mins < b : mins >= a || mins < b;
  }

  private tick() {
    if (this.current || this.stopped || this.cfg.jobsPaused) return;
    const queued = this.store.jobs().filter((j) => j.state === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    const next = queued.find((j) => !j.scheduled || this.inIdleWindow());
    if (!next) return;
    this.run(next);
  }

  private run(job: Job) {
    if (!this.aiDir) return this.fail(job, 'The AI worker scripts are missing from this install.');
    const outDir = join(this.cfg.dataDir, 'jobs', job.id);
    mkdirSync(outDir, { recursive: true });
    const args = job.kind === ('setup' as JobKind)
      ? [join(this.aiDir, 'fretforge_ai.py'), 'setup', JSON.stringify({ ...job.params, venv: this.venvDir })]
      : [join(this.aiDir, 'fretforge_ai.py'), job.kind, JSON.stringify({ ...job.params, out: outDir, device: this.store.prefs().ai.device })];
    const py = job.kind === ('setup' as JobKind) ? (this.cfg.python || 'python3') : this.python();
    let proc: ChildProcess;
    try {
      proc = spawn(py, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    } catch (e) {
      return this.fail(job, `Python could not start: ${(e as Error).message}`);
    }
    job.state = 'running';
    job.startedAt = Date.now();
    job.message = 'Starting';
    this.store.putJob(job);
    this.current = { job, proc };
    let buf = '';
    let err = '';
    let result: Record<string, unknown> | null = null;
    let failure: string | null = null;
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const m = JSON.parse(line) as { progress?: number; message?: string; result?: Record<string, unknown>; error?: string };
          if (typeof m.progress === 'number') job.progress = Math.max(0, Math.min(1, m.progress));
          if (m.message) job.message = m.message.slice(0, 300);
          if (m.result) result = m.result;
          if (m.error) failure = m.error;
          this.store.putJob(job);
        } catch { /* not ours */ }
      }
    });
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (d: string) => { err = (err + d).slice(-4000); });
    proc.on('error', (e) => { failure = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'Python was not found. Set up the AI tools in Settings.' : e.message; });
    proc.on('close', (code) => {
      this.current = null;
      if (job.state === 'cancelled') { this.store.putJob(job); return; }
      if (code === 0 && result && !failure) {
        job.state = 'done';
        job.progress = 1;
        job.result = result;
        job.message = 'Done';
        job.finishedAt = Date.now();
        try { this.handlers.onResult?.(job); } catch (e) { job.state = 'failed'; job.message = `Could not save the result: ${(e as Error).message}`; }
        this.store.putJob(job);
        if (job.kind === ('setup' as JobKind)) this.refreshStatus();
      } else {
        const tail = err.trim().split('\n').filter(Boolean).slice(-2).join(' ');
        this.fail(job, failure || (tail ? `The worker stopped: ${tail}` : `The worker stopped (exit code ${code}).`));
      }
      setImmediate(() => this.tick());
    });
  }

  private fail(job: Job, message: string) {
    job.state = 'failed';
    job.message = message.slice(0, 500);
    job.finishedAt = Date.now();
    this.store.putJob(job);
  }
}

/** Registers the stems a separation job wrote as audio assets of the song. */
export function registerStems(store: Store, dataDir: string, job: Job): AudioAsset[] {
  const parent = job.audioId ? store.audio(job.audioId) : undefined;
  if (!parent) throw new Error('The recording was removed while it was being separated.');
  const files = (job.result?.stems ?? {}) as Record<string, string>;
  const out: AudioAsset[] = [];
  // replace stems from an earlier run of the same recording
  for (const a of store.audioFor(parent.songId)) if (a.parentId === parent.id) store.removeAudio(a.id);
  const destDir = join(dataDir, 'audio', parent.songId);
  mkdirSync(destDir, { recursive: true });
  const label: Record<string, string> = {
    guitar: 'Guitar', bass: 'Bass', drums: 'Drums', piano: 'Piano', vocals: 'Vocals', other: 'Other', 'lead-guitar': 'Lead guitar', 'rhythm-guitar': 'Rhythm guitar',
  };
  for (const [stem, path] of Object.entries(files)) {
    if (!existsSync(path)) continue;
    const id = newId();
    const rel = join('audio', parent.songId, `${id}.flac`);
    // move by copy+delete so it works across file systems
    copyFileSync(path, join(dataDir, rel));
    try { unlinkSync(path); } catch { /* ignore */ }
    const a: AudioAsset = {
      id, songId: parent.songId, kind: 'stem', stem: stem as StemName, parentId: parent.id, name: label[stem] ?? stem,
      file: rel, mime: 'audio/flac', bytes: statSync(join(dataDir, rel)).size, durationMs: parent.durationMs, gainDb: 0,
      syncPoints: parent.syncPoints, offsetMs: parent.offsetMs, createdAt: Date.now(),
    };
    store.putAudio(a);
    out.push(a);
  }
  try { rmSync(join(dataDir, 'jobs', job.id), { recursive: true, force: true }); } catch { /* ignore */ }
  return out;
}

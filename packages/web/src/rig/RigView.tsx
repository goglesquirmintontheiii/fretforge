import { useMemo, useState } from 'react';
import { NAM_ROLES, type NamRole, type RigFile } from '@fretforge/shared';
import { api } from '../api';
import { go, useApp } from '../lib/app';
import { askConfirm } from '../lib/dialog';
import { describeRigFile, refreshRigFiles, useRigFiles, useUpload } from '../components/AmpEditor';
import { Icon } from '../components/icons';
import { JobRow, useJobs } from '../player/AudioPanel';
import { RigEditor } from './RigEditor';
import { NamSearch } from './NamSearch';
import { roleLabel } from './BlockLibrary';

export type RigTab = 'rigs' | 'library' | 'find' | 'train';

export function RigView({ tab = 'rigs', id, type }: { tab?: RigTab; id?: string; type?: string }) {
  const { user } = useApp();
  const canEdit = user?.role !== 'viewer';
  const tabs: [RigTab, string, string][] = [['rigs', 'Rigs', '/rig'], ['library', 'Models & IRs', '/rig/library'], ['find', 'Find models', '/rig/find'], ...(canEdit ? [['train', 'Train a capture', '/rig/train'] as [RigTab, string, string]] : [])];
  return (
    <div className={'rigview' + (tab === 'rigs' ? ' full' : '')}>
      <nav className="rigtabs" aria-label="Rig">
        {tabs.map(([k, label, href]) => <a key={k} href={`#${href}`} aria-current={tab === k ? 'page' : undefined}>{label}</a>)}
      </nav>
      {tab === 'rigs' && <RigEditor rigId={id} />}
      {tab === 'library' && <div className="page"><RigLibrary canEdit={canEdit} /></div>}
      {tab === 'find' && <div className="page"><div className="section-h"><h2>Find models</h2><span className="muted">Free NAM captures and cabinet IRs from TONE3000 and community collections</span></div><NamSearch initialType={type} /></div>}
      {tab === 'train' && canEdit && <div className="page"><TrainCapture /></div>}
    </div>
  );
}

// ------------------------------------------------------------------ library of .nam and .wav files
function RigLibrary({ canEdit }: { canEdit: boolean }) {
  const files = useRigFiles();
  const { toast } = useApp();
  const [role, setRole] = useState<NamRole | 'auto'>('auto');
  const { pick, busy } = useUpload(undefined, role === 'auto' ? undefined : role);
  const [kind, setKind] = useState<'all' | 'ir' | NamRole>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const list = useMemo(() => (files ?? []).filter((f) => (kind === 'all' || (kind === 'ir' ? f.kind === 'ir' : f.kind === 'nam' && (f.role ?? 'amp') === kind))
    && (!q || `${f.name} ${f.tags.join(' ')} ${f.gearMake ?? ''} ${f.gearModel ?? ''} ${f.author ?? ''} ${f.pack ?? ''} ${(f.tones ?? []).join(' ')} ${(f.genres ?? []).join(' ')}`.toLowerCase().includes(q.toLowerCase()))), [files, kind, q]);
  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <div className="section-h">
        <h2>Models and IRs</h2>
        <span className="muted">{files?.length ?? 0} file{files?.length === 1 ? '' : 's'}</span>
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => go('/rig/find')}>{Icon.search({ size: 14 })} Find models online</button>
        {canEdit && (
          <span className="row" style={{ gap: 6 }}>
            <select value={role} onChange={(e) => setRole(e.target.value as NamRole | 'auto')} aria-label="Import models as">
              <option value="auto">Import as: detect</option>
              {NAM_ROLES.map((r) => <option key={r.id} value={r.id}>Import as: {r.label}</option>)}
            </select>
            <button className="btn sm" onClick={() => pick()} disabled={busy}>{busy ? <span className="spinner" /> : Icon.upload({ size: 15 })} Add .nam, .wav or .zip</button>
          </span>
        )}
      </div>
      <div className="row">
        <div className="chips" role="group" aria-label="Type">
          <button className="chip" aria-pressed={kind === 'all'} onClick={() => setKind('all')}>All</button>
          {NAM_ROLES.map((r) => <button key={r.id} className="chip" aria-pressed={kind === r.id} onClick={() => setKind(r.id)}>{r.label}</button>)}
          <button className="chip" aria-pressed={kind === 'ir'} onClick={() => setKind('ir')}>Cab IRs</button>
        </div>
        <input type="search" id="rig-filter" className="grow" placeholder="Filter by name, tag, gear, tone, pack or author" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter models" />
      </div>
      {files === null ? <div className="empty"><span className="spinner" /></div> : list.length === 0 ? (
        <div className="empty"><b>{files.length ? 'Nothing matches' : 'No models yet'}</b>{files.length ? '' : 'Add NAM captures (.nam) of amps, preamps, pedals, cabs or full rigs and cabinet impulse responses (.wav), one by one or as .zip packs, or find free ones online.'}</div>
      ) : (
        <div className="card songlist">
          {list.map((f) => (
            <div key={f.id} className="rigfile">
              <span className={'kind ' + f.kind}>{f.kind === 'nam' ? roleLabel(f.role).toUpperCase().slice(0, 5) : 'IR'}</span>
              <div style={{ minWidth: 0 }}>
                {editing === f.id ? <RigFileForm f={f} onDone={() => setEditing(null)} /> : (
                  <>
                    <div className="t">{f.name}</div>
                    <div className="a">{describeRigFile(f)}{f.author ? ` · by ${f.author}` : ''}{f.pack ? ` · ${f.pack}` : ''}{f.source?.kind === 'tone3000' ? ' · TONE3000' : f.source?.kind === 'github' ? ' · GitHub' : ''}</div>
                    {(f.tags.length > 0 || (f.tones ?? []).length > 0 || (f.genres ?? []).length > 0) && <div className="chips" style={{ marginTop: 4 }}>
                      {(f.tones ?? []).map((t) => <span key={`t${t}`} className="badge">{t}</span>)}
                      {(f.genres ?? []).map((t) => <span key={`g${t}`} className="badge info">{t}</span>)}
                      {f.tags.map((t) => <span key={t} className="badge">{t}</span>)}
                    </div>}
                  </>
                )}
              </div>
              {canEdit && editing !== f.id && (
                <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                  {f.source?.url && <a className="iconbtn" href={f.source.url} target="_blank" rel="noreferrer" aria-label="Source page">{Icon.external({ size: 15 })}</a>}
                  <button className="iconbtn" aria-label={`Edit ${f.name}`} onClick={() => setEditing(f.id)}>{Icon.edit({ size: 15 })}</button>
                  <button className="iconbtn" aria-label={`Delete ${f.name}`} onClick={async () => {
                    if (!(await askConfirm(`Delete “${f.name}”?`, { body: 'Rigs that use it pass the signal through without it.', ok: 'Delete', danger: true }))) return;
                    await api.deleteRigFile(f.id).catch((e) => toast(e.message));
                    refreshRigFiles();
                  }}>{Icon.trash({ size: 15 })}</button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RigFileForm({ f, onDone }: { f: RigFile; onDone: () => void }) {
  const [name, setName] = useState(f.name);
  const [tags, setTags] = useState(f.tags.join(', '));
  const [role, setRole] = useState<NamRole>(f.role ?? 'amp');
  const [author, setAuthor] = useState(f.author ?? '');
  return (
    <form className="row" style={{ gap: 6 }} onSubmit={async (e) => {
      e.preventDefault();
      await api.patchRigFile(f.id, { name, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), role: f.kind === 'nam' ? role : undefined, author });
      await refreshRigFiles();
      onDone();
    }}>
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
      {f.kind === 'nam' && (
        <select value={role} onChange={(e) => setRole(e.target.value as NamRole)} aria-label="What it is">
          {NAM_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      )}
      <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" placeholder="tags, comma separated" />
      <input type="text" value={author} onChange={(e) => setAuthor(e.target.value)} aria-label="Author" placeholder="Author" />
      <button className="btn sm primary">Save</button>
      <button type="button" className="btn sm" onClick={onDone}>Cancel</button>
    </form>
  );
}

// ------------------------------------------------------------------ training your own captures
function TrainCapture() {
  const { toast } = useApp();
  const { jobs, ai, refresh } = useJobs();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [epochs, setEpochs] = useState(100);
  const training = jobs.filter((j) => j.kind === 'train-nam').slice(0, 5);
  return (
    <section className="card setcard">
      <h3>Train a capture</h3>
      <p className="muted" style={{ margin: 0 }}>
        Reamp NAM’s standard test signal (input.wav from the NAM project) through your amp or pedal, record the result at the same sample rate and length, and upload the recording.
        Training runs in the AI worker and the finished model lands in your library. Put the test signal next to the worker script (<span className="mono">ai/input.wav</span>).
      </p>
      <div className="row">
        <input type="file" accept=".wav,audio/wav" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Recorded output" />
        <input type="text" placeholder="Name, e.g. My amp – crunch" value={name} onChange={(e) => setName(e.target.value)} aria-label="Capture name" />
        <label className="row" style={{ gap: 6 }}>Epochs <input type="number" min={10} max={1000} value={epochs} onChange={(e) => setEpochs(Number(e.target.value) || 100)} style={{ width: 80 }} /></label>
        <button className="btn" disabled={!file || !name.trim() || !ai?.available} title={ai?.available ? '' : ai?.reason} onClick={async () => {
          try { await api.trainNam(file!, name.trim(), epochs); refresh(); toast('Training started'); } catch (e) { toast((e as Error).message); }
        }}>Train</button>
      </div>
      {training.map((j) => <JobRow key={j.id} j={j} onCancel={() => api.cancelJob(j.id).then(refresh)} />)}
    </section>
  );
}

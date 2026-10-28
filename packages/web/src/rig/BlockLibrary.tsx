// The block palette: categories, search, and your captures by role. Drag a block onto the
// canvas, or tap it to insert at the chosen slot.
import { useMemo, useState } from 'react';
import { CATEGORY_LABELS, CATEGORY_ORDER, RIG_BLOCKS, type BlockCategory, type RigFile } from '@fretforge/shared';
import { CAT_COLOR, CatGlyph } from './blockArt';
import { startDrag } from './ChainCanvas';
import type { Slot } from './rigOps';

const ROLE_BLOCK: Record<string, number> = { amp: 100, preamp: 101, pedal: 102, cab: 103, 'full-rig': 104, outboard: 102 };

export function BlockLibrary({ files, onAdd, onDropAt, liveOnlyOk }: {
  files: RigFile[];
  /** tap: insert at the chosen slot (or the end) */
  onAdd(type: number, extra?: { nam?: string; ir?: string }): void;
  onDropAt(type: number, slot: Slot, extra?: { nam?: string; ir?: string }): void;
  liveOnlyOk: boolean;
}) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<BlockCategory | 'all' | 'captures'>('all');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const blocks = useMemo(() => RIG_BLOCKS.filter((b) => (cat === 'all' || b.category === cat) && (liveOnlyOk || !b.liveOnly)
    && (!words.length || words.every((w) => `${b.name} ${b.description} ${CATEGORY_LABELS[b.category]}`.toLowerCase().includes(w)))), [cat, q, liveOnlyOk]); // eslint-disable-line react-hooks/exhaustive-deps
  const captures = useMemo(() => files.filter((f) => (cat === 'all' || cat === 'captures' || (f.kind === 'ir' ? cat === 'cab' : ROLE_BLOCK[f.role ?? 'amp'] && blockCat(f) === cat))
    && (!words.length || words.every((w) => `${f.name} ${f.gearMake ?? ''} ${f.gearModel ?? ''} ${f.tags.join(' ')} ${f.role ?? ''}`.toLowerCase().includes(w)))), [files, cat, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = CATEGORY_ORDER.map((c) => ({ c, items: blocks.filter((b) => b.category === c) })).filter((g) => g.items.length);
  return (
    <div className="blib">
      <input type="search" placeholder="Search blocks and captures" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search blocks" id="block-search" />
      <div className="chips blibcats" role="group" aria-label="Category">
        <button className="chip" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>All</button>
        <button className="chip" aria-pressed={cat === 'captures'} onClick={() => setCat('captures')}>My captures</button>
        {CATEGORY_ORDER.map((c) => <button key={c} className="chip" aria-pressed={cat === c} onClick={() => setCat(c)} style={{ ['--cat' as string]: CAT_COLOR[c] }}><i className="catdot" />{CATEGORY_LABELS[c]}</button>)}
      </div>
      {cat !== 'captures' && groups.map((g) => (
        <section key={g.c}>
          <h4>{CATEGORY_LABELS[g.c]}</h4>
          <div className="blibgrid">
            {g.items.map((b) => (
              <button key={b.type} className="blibitem" style={{ ['--cat' as string]: CAT_COLOR[b.category] }} title={b.description}
                onPointerDown={(e) => startDrag(e, { kind: 'new', type: b.type }, b.name, CAT_COLOR[b.category], (slot) => onDropAt(b.type, slot), () => onAdd(b.type))}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAdd(b.type); } }}>
                <span className="glyph"><CatGlyph cat={b.category} /></span>
                <span className="nm">{b.name}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {captures.length > 0 && (cat === 'all' || cat === 'captures' || ['amp', 'preamp', 'cab', 'capture'].includes(cat)) && (
        <section>
          <h4>Your captures and IRs</h4>
          <div className="blibcaps">
            {captures.slice(0, 200).map((f) => {
              const type = f.kind === 'ir' ? 105 : ROLE_BLOCK[f.role ?? 'amp'] ?? 100;
              const extra = f.kind === 'ir' ? { ir: f.id } : { nam: f.id };
              const c = blockCat(f);
              return (
                <button key={f.id} className="blibcap" style={{ ['--cat' as string]: CAT_COLOR[c] }} title={`${f.name} (${f.kind === 'ir' ? 'IR' : f.role ?? 'amp'})`}
                  onPointerDown={(e) => startDrag(e, { kind: 'new', type }, f.name, CAT_COLOR[c], (slot) => onDropAt(type, slot, extra), () => onAdd(type, extra))}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAdd(type, extra); } }}>
                  <span className="glyph"><CatGlyph cat={c} /></span>
                  <span className="nm">{f.name}</span>
                  <span className="badge">{f.kind === 'ir' ? 'IR' : roleLabel(f.role)}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
      {!groups.length && !captures.length && <p className="muted">Nothing matches.</p>}
    </div>
  );
}

function blockCat(f: RigFile): BlockCategory {
  if (f.kind === 'ir') return 'cab';
  switch (f.role) {
    case 'preamp': return 'preamp';
    case 'pedal': case 'outboard': return 'capture';
    case 'cab': return 'cab';
    default: return 'amp';
  }
}

export function roleLabel(r: RigFile['role']): string {
  return r === 'full-rig' ? 'Full rig' : r ? r[0].toUpperCase() + r.slice(1) : 'Amp';
}

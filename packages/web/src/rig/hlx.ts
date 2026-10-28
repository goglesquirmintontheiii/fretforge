// Importing a Line 6 Helix preset (.hlx, the user's own export): each block maps to the nearest
// Fretforge block by its model name; amps and cabs become empty capture/IR slots to fill. Only
// the layout and common settings carry over, so the result is a starting point.
import { BLOCK_BY_TYPE, emptyRig, newBlock, newSplit, type RigBlock, type RigDoc, type RigNode } from '@fretforge/shared';

/** [pattern on the Helix model id, Fretforge block type] in priority order */
const MAP: [RegExp, number][] = [
  [/Scream808|TS808|Screamer|TS9/i, 1],
  [/Minotaur|Klon/i, 2], [/KinkyBoost|Kinky|EP ?Boost/i, 3], [/Teemah/i, 4], [/Compulsive|OCD/i, 5], [/Vermin|RAT/i, 6],
  [/Triangle|RamsHead|Ram'?s|Muff|Pocket/i, 7], [/Arbitrator|FuzzFace|Face|Wringer/i, 8], [/Industrial|ToneBender|Bender/i, 9],
  [/Rangemaster|Range|TrebleBooster|Hedgehog/i, 10], [/Octavia|Octi|Tycoctavia/i, 11], [/Dist|Drive|Fuzz|Boost|Screamer|Valve/i, 1],
  [/RedSqueeze|Squeeze|Dyna/i, 20], [/LAStudio|LA ?Studio|Opto/i, 21], [/Deluxe ?Comp|Kinky ?Comp|Compressor|Comp/i, 22], [/3 ?Band|Multiband/i, 23],
  [/Horizon/i, 25], [/Gate/i, 24],
  [/Parametric|ParaEQ/i, 31], [/10 ?Band|Graphic/i, 32], [/Cali ?Q|Mesa|5 ?Band/i, 34], [/LowHighCut|Low ?Cut|High ?Cut/i, 33], [/EQ/i, 30],
  [/Volume/i, 40], [/Gain/i, 41], [/Pan/i, 42], [/Width|Stereo ?Imager/i, 43],
  [/Dimension|Trinity/i, 51], [/Chorus|Chorus/i, 50], [/Flanger|Flange/i, 52], [/ScriptModPhase|Script|Phase ?90/i, 54], [/Phaser|Phase/i, 53],
  [/Vibe|Ubiquitous/i, 55], [/Tremolo|Trem/i, 56], [/Rotary|Leslie|145/i, 57], [/Ring/i, 58],
  [/Tape|Echoplex|Space ?Echo|Transistor/i, 62], [/Analog|Adriatic|Elephant|Bucket|DM ?4/i, 61], [/PingPong|Ping ?Pong/i, 63], [/Dual ?Delay/i, 64],
  [/Reverse/i, 65], [/Ducked/i, 66], [/Multi ?Pass|Multitap|Multi ?Tap/i, 67], [/Delay|Echo/i, 60],
  [/Spring|63 ?Spring/i, 73], [/Plate/i, 72], [/Chamber/i, 74], [/Searchlights|Plateaux|Shimmer/i, 75], [/Ganymede|Ambient|Cave|Octo/i, 76], [/Hall|Glitz/i, 71], [/Room|Reverb/i, 70],
  [/Wham/i, 80], [/Poly ?Capo|Capo/i, 83], [/Harmony|Twin ?Harmony/i, 82], [/Octave|OC ?2|Octaver/i, 84], [/Pitch/i, 81],
  [/Mutant|Envelope|Mu-?Tron|Auto ?Wah/i, 90], [/Mystery|Synth|Ladder|Filter/i, 91], [/Chrome|Vox|V847/i, 93], [/Wah|Teardrop|Fassel|Throaty/i, 92],
  [/Looper/i, 110],
];

function mapModel(model: string): number | 'amp' | 'cab' | 'ir' | null {
  if (/ImpulseResponse|IR\d/i.test(model)) return 'ir';
  if (/_Cab|Cab/i.test(model) && !/Amp/i.test(model)) return 'cab';
  if (/_Amp|Amp|Preamp/i.test(model)) return 'amp';
  for (const [re, t] of MAP) if (re.test(model)) return t;
  return null;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** copies the common Helix settings (0..1 knobs, seconds, dB) onto a block */
function copyParams(b: RigBlock, src: Record<string, unknown>) {
  const def = BLOCK_BY_TYPE.get(b.type);
  if (!def) return;
  const get = (...keys: string[]) => { for (const k of keys) if (typeof src[k] === 'number') return src[k] as number; return undefined; };
  for (const p of def.params) {
    let v: number | undefined;
    switch (p.id) {
      case 'drive': case 'gain': case 'distortion': case 'sustain': case 'fuzz': case 'attack':
        v = get('Drive', 'Gain', 'Distortion', 'Sustain', 'Fuzz'); if (v !== undefined && p.unit === 'knob') v *= 10; break;
      case 'tone': case 'filter': case 'treble':
        v = get('Tone', 'Filter', 'Treble'); if (v !== undefined && p.unit === 'knob') v *= 10; break;
      case 'level': case 'volume': case 'output':
        v = get('Level', 'Volume', 'Output'); if (v !== undefined && Math.abs(v) <= 1 && p.unit === 'dB') v = (v - 0.5) * 24; break;
      case 'time': v = get('Time'); if (v !== undefined) v = v * 1000; break;
      case 'feedback': v = get('Feedback'); break;
      case 'mix': v = get('Mix'); break;
      case 'decay': v = get('Decay'); if (v !== undefined && p.unit === 's' && v <= 1) v = 0.5 + v * 8; break;
      case 'predelay': v = get('Predelay'); if (v !== undefined) v *= 1000; break;
      case 'rate': case 'speed': v = get('Speed', 'Rate'); break;
      case 'depth': case 'intensity': v = get('Depth', 'Intensity'); break;
      case 'threshold': v = get('Threshold'); break;
      case 'position': v = get('Position', 'Pedal'); break;
    }
    if (v !== undefined && Number.isFinite(v)) b.params[p.id] = Math.min(p.max, Math.max(p.min, v));
  }
}

export function importHlx(text: string): { rig: RigDoc; notes: string[] } {
  let j: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { j = JSON.parse(text); } catch { throw new Error('That isn’t a Helix preset file.'); }
  const tone = j?.data?.tone;
  if (!tone || typeof tone !== 'object') throw new Error('That file has no Helix tone in it.');
  const rig = emptyRig(String(j?.data?.meta?.name || 'Helix preset').slice(0, 80));
  rig.paths = [];
  const notes: string[] = [];
  const empty = { amp: 0, cab: 0, unknown: [] as string[] };
  for (const dspKey of ['dsp0', 'dsp1']) {
    const dsp = tone[dspKey];
    if (!dsp || typeof dsp !== 'object') continue;
    const blocks = Object.entries(dsp)
      .filter(([k, v]) => /^block\d+$/.test(k) && v && typeof v === 'object')
      .map(([, v]) => v as Record<string, unknown>)
      .sort((a, b) => num(a['@position']) - num(b['@position']));
    const laneB = blocks.filter((b) => num(b['@path']) === 1);
    const nodes: RigNode[] = [];
    const toBlock = (src: Record<string, unknown>): RigBlock | null => {
      const model = String(src['@model'] ?? '');
      const t = mapModel(model);
      if (t === null) { empty.unknown.push(model.replace(/^HD2_/, '')); return null; }
      let b: RigBlock;
      if (t === 'amp') { b = newBlock(100); empty.amp++; }
      else if (t === 'cab' || t === 'ir') { b = newBlock(105); empty.cab++; }
      else { b = newBlock(t); copyParams(b, src); }
      b.enabled = src['@enabled'] !== false;
      b.label = model.replace(/^HD2_/, '').replace(/([a-z])([A-Z])/g, '$1 $2').slice(0, 40);
      return b;
    };
    if (laneB.length) {
      const split = newSplit();
      const splitPos = num((dsp.split as Record<string, unknown> | undefined)?.['@position'], Math.min(...laneB.map((b) => num(b['@position']))));
      const joinPos = num((dsp.join as Record<string, unknown> | undefined)?.['@position'], 99);
      for (const src of blocks) {
        const pos = num(src['@position']);
        const b = toBlock(src);
        if (!b) continue;
        if (num(src['@path']) === 1) split.b.push(b);
        else if (pos >= splitPos && pos < joinPos) split.a.push(b);
        else if (pos < splitPos) nodes.push(b);
      }
      nodes.push(split);
      for (const src of blocks) {
        if (num(src['@path']) === 1 || num(src['@position']) < joinPos) continue;
        const b = toBlock(src);
        if (b) nodes.push(b);
      }
    } else {
      for (const src of blocks) { const b = toBlock(src); if (b) nodes.push(b); }
    }
    rig.paths.push({ nodes, level: 0, pan: 0 });
  }
  if (!rig.paths.length) rig.paths.push({ nodes: [], level: 0, pan: 0 });
  if (rig.paths.length > 1 && !rig.paths[1].nodes.length) rig.paths.pop();
  if (empty.amp) notes.push(`${empty.amp} amp${empty.amp === 1 ? '' : 's'} became capture slots: pick a NAM model for each.`);
  if (empty.cab) notes.push(`${empty.cab} cab${empty.cab === 1 ? '' : 's'} became IR slots: pick an impulse response.`);
  if (empty.unknown.length) notes.push(`Left out (no match): ${[...new Set(empty.unknown)].slice(0, 6).join(', ')}.`);
  // snapshots: names only; their block states vary too much between firmware versions to map safely
  const snaps = Object.entries(tone).filter(([k]) => /^snapshot\d+$/.test(k)).map(([, v]) => v as Record<string, unknown>).filter((s) => s['@valid'] !== false);
  if (snaps.length > 1) rig.snapshots = snaps.slice(0, 8).map((s, i) => ({ name: String(s['@name'] || `Snapshot ${i + 1}`).slice(0, 30), blocks: {} }));
  return { rig, notes };
}

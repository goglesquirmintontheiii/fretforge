/*
 * Original demo songs written for Fretforge, so a fresh install has something to play.
 * "Fretforge Shuffle" is built through the Songsterr converter (it exercises chords,
 * sections, lyrics and drums); "Morning Arpeggios" is alphaTex; "Kitchen Light" is a chord sheet.
 */
import * as alphaTab from '@coderline/alphatab';
import type { Library } from './library';
import { songsterrToScore, type SongsterrBeat, type SongsterrMeasure, type SongsterrTrackPayload } from './providers/songsterrConvert';

type Chord = 'A' | 'D' | 'E';
const FORM: Chord[] = ['A', 'A', 'A', 'A', 'D', 'D', 'A', 'A', 'E', 'D', 'A', 'E'];

// Songsterr strings: 0 = high e ... 5 = low E. [rootString, shapeString]
const GTR: Record<Chord, [number, number]> = { A: [4, 3], D: [3, 2], E: [5, 4] };
const beat = (dur: number, notes: { fret: number; string: number }[], extra: Partial<SongsterrBeat> = {}): SongsterrBeat =>
  ({ type: dur, duration: [1, dur], notes, ...extra });
const rest = (dur: number): SongsterrBeat => ({ type: dur, duration: [1, dur], rest: true, notes: [{ rest: true } as any] });

function guitarBar(ch: Chord, i: number, last: boolean): SongsterrMeasure {
  const [root, shape] = GTR[ch];
  if (last) {
    return { voices: [{ beats: [beat(1, [{ fret: 0, string: root }, { fret: 2, string: shape }, { fret: 2, string: shape - 1 }], { chord: { text: ch + '5' }, letRing: true })] }] };
  }
  const pattern = [2, 2, 4, 4, 2, 2, 4, 5];
  const beats = pattern.map((f, k) => beat(8, [{ fret: 0, string: root }, { fret: f, string: shape }], {
    ...(k === 0 && (i === 0 || FORM[i - 1] !== ch) ? { chord: { text: ch + '5' } } : {}),
    ...(k % 2 === 0 ? { palmMute: true } : {}),
  }));
  return { voices: [{ beats }] };
}

// Bass strings: 0 = G, 1 = D, 2 = A, 3 = E
const BASS: Record<Chord, [number, number][]> = {
  A: [[2, 0], [2, 4], [1, 2], [1, 4]],
  D: [[1, 0], [1, 4], [0, 2], [0, 4]],
  E: [[3, 0], [3, 4], [2, 2], [2, 4]],
};
function bassBar(ch: Chord, last: boolean): SongsterrMeasure {
  if (last) return { voices: [{ beats: [beat(1, [{ string: BASS[ch][0][0], fret: BASS[ch][0][1] }])] }] };
  return { voices: [{ beats: BASS[ch].map(([s, f]) => beat(4, [{ string: s, fret: f }])) }] };
}

function drumBar(i: number, last: boolean): SongsterrMeasure {
  if (last) return { voices: [{ beats: [beat(1, [{ fret: 49, string: 0 }, { fret: 36, string: 5 }])] }] };
  const beats: SongsterrBeat[] = [];
  for (let k = 0; k < 8; k++) {
    const n = [{ fret: k === 0 && i === 0 ? 49 : 42, string: 0 }];
    if (k === 0 || k === 4 || (k === 5 && i % 2 === 1)) n.push({ fret: 36, string: 5 });
    if (k === 2 || k === 6) n.push({ fret: 38, string: 3 });
    beats.push(beat(8, n));
  }
  return { voices: [{ beats }] };
}

function shuffle() {
  const bars = FORM.length + 1;
  const g: SongsterrMeasure[] = [], b: SongsterrMeasure[] = [], d: SongsterrMeasure[] = [];
  for (let i = 0; i < bars; i++) {
    const last = i === bars - 1;
    const ch = last ? 'A' : FORM[i];
    const gm = guitarBar(ch, i, last);
    if (i === 0) { gm.signature = [4, 4]; gm.marker = 'Verse'; }
    if (i === 8) gm.marker = 'Turnaround';
    if (last) gm.marker = 'Ending';
    g.push(gm);
    b.push(bassBar(ch, last));
    d.push(drumBar(i, last));
  }
  const guitar: SongsterrTrackPayload = {
    name: 'Rhythm Guitar', instrumentId: 29, tuning: [64, 59, 55, 50, 45, 40], measures: g,
    automations: { tempo: [{ measure: 0, position: 0, bpm: 116, type: 4 }] },
  };
  const vocalBars: SongsterrMeasure[] = [];
  const melody: [number, number][] = [[2, 2], [2, 4], [1, 2]]; // a three-note phrase (string, fret), moved up for D and E
  for (let i = 0; i < bars; i++) {
    if (i % 4 === 0 && i < 12) vocalBars.push({ voices: [{ beats: [rest(4), ...melody.map(([s, f]) => beat(4, [{ string: s, fret: f + (FORM[i] === 'D' ? 5 : FORM[i] === 'E' ? 7 : 0) }]))] }] });
    else vocalBars.push({ voices: [{ beats: [rest(1)] }] });
  }
  const vocals: SongsterrTrackPayload = {
    name: 'Vocals', instrumentId: 54, tuning: [64, 59, 55, 50, 45, 40], measures: vocalBars,
    newLyrics: [{ line: 1, offset: 1, text: 'Turn it up\nShake the floor\nPlay it once more' }],
  };
  const bass: SongsterrTrackPayload = { name: 'Bass', instrumentId: 33, tuning: [43, 38, 33, 28], measures: b };
  const drums: SongsterrTrackPayload = { name: 'Drums', instrumentId: 1024, measures: d };
  return songsterrToScore({
    meta: { title: 'Fretforge Shuffle', artist: 'Fretforge Demos' },
    tracks: [
      { meta: { partId: 0, instrumentId: 29, title: 'Rhythm Guitar' }, payload: guitar },
      { meta: { partId: 1, instrumentId: 33, title: 'Bass' }, payload: bass },
      { meta: { partId: 2, instrumentId: 1024, title: 'Drums', isDrums: true }, payload: drums },
      { meta: { partId: 3, instrumentId: 54, title: 'Vocals' }, payload: vocals },
    ],
  }).score;
}

function arpeggios(): alphaTab.model.Score {
  const shapes: [string, string][] = [
    ['C', '3.5.8 2.4.8 0.3.8 1.2.8 0.1.8 1.2.8 0.3.8 2.4.8'],
    ['Am', '0.5.8 2.4.8 2.3.8 1.2.8 0.1.8 1.2.8 2.3.8 2.4.8'],
    ['F', '3.4.8 3.3.8 2.3.8 1.2.8 1.1.8 1.2.8 2.3.8 3.3.8'],
    ['G', '3.6.8 2.5.8 0.4.8 0.3.8 3.1.8 0.3.8 0.4.8 2.5.8'],
  ];
  const bar = ([name, notes]: [string, string]) => notes.replace(/^(\S+)/, `$1 {ch "${name}"}`);
  const body = [...shapes, ...shapes].map(bar).join(' |\n') + ' |\n(3.5 2.4 0.3 1.2 0.1).1 {ch "C"}';
  const tex = `\\title "Morning Arpeggios"\n\\artist "Fretforge Demos"\n\\tempo 84\n\\track "Acoustic Guitar" \\staff {tabs score} \\tuning (e4 b3 g3 d3 a2 e2) \\instrument 25\n${body}`;
  const imp = new alphaTab.importer.AlphaTexImporter();
  imp.initFromString(tex, new alphaTab.Settings());
  return imp.readScore();
}

const KITCHEN_LIGHT = `[Intro]
[ch]G[/ch]   [ch]D[/ch]   [ch]Em[/ch]   [ch]C[/ch]

[Verse 1]
[tab][ch]G[/ch]                 [ch]D[/ch]
Kettle's on and the radio's low
[ch]Em[/ch]                    [ch]C[/ch]
Rain on the window, nowhere to go[/tab]
[tab][ch]G[/ch]                  [ch]D[/ch]
Coffee rings on yesterday's news
[ch]Em[/ch]              [ch]C[/ch]
Worn-out socks and borrowed shoes[/tab]

[Chorus]
[tab][ch]C[/ch]          [ch]G[/ch]
Leave the kitchen light on
[ch]D[/ch]              [ch]Em[/ch]
I'll be home before long
[ch]C[/ch]            [ch]G[/ch]         [ch]D[/ch]
Hum me the tune of an old summer song[/tab]

[Outro]
[ch]G[/ch]   [ch]D[/ch]   [ch]C[/ch]   [ch]G[/ch]`;

export function seedDemos(lib: Library) {
  lib.importScore({ score: shuffle(), source: { kind: 'demo', ref: 'fretforge-shuffle' } });
  lib.importScore({ score: arpeggios(), source: { kind: 'demo', ref: 'morning-arpeggios' } });
  lib.importText({
    tab: { content: KITCHEN_LIGHT, capo: 2, tuning: 'E A D G B E', key: 'G', shapes: {}, type: 'Chords' },
    source: { kind: 'demo', ref: 'kitchen-light', variant: 'Chords' },
    title: 'Kitchen Light', artist: 'Fretforge Demos', instruments: ['guitar'],
  });
}

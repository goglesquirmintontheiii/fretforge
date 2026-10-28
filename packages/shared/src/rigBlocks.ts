// Catalog of the rig blocks built into forge-dsp. The `type` numbers and the order of `params`
// must match packages/engine/src/blocks*.cpp (the engine test checks the counts).
//
// Names are our own; descriptions say which classic circuit a block is modelled on.

export type BlockCategory =
  | 'drive' | 'dynamics' | 'eq' | 'volume' | 'modulation' | 'delay' | 'reverb' | 'pitch' | 'filter' | 'wah'
  | 'amp' | 'preamp' | 'cab' | 'capture' | 'looper';

export type ParamUnit = 'dB' | 'Hz' | 'ms' | 's' | '%' | 'st' | 'ct' | 'knob' | '';

export interface ParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  def: number;
  unit: ParamUnit;
  /** exponential knob (frequencies, times) */
  log?: boolean;
  step?: number;
  /** discrete choices; the value is the index (or the matching entry of `values`) */
  options?: string[];
  values?: number[];
  /** expression pedal target by default (wah, whammy, volume) */
  expression?: boolean;
}

export interface BlockDef {
  type: number;
  key: string;
  name: string;
  category: BlockCategory;
  description: string;
  stereo: boolean;
  timeBased?: boolean;
  /** NAM model slot (which kind of capture fits) and IR slots */
  nam?: 'amp' | 'preamp' | 'pedal' | 'cab' | 'full-rig';
  irSlots?: number;
  liveOnly?: boolean;
  params: ParamDef[];
}

const knob = (id: string, label: string, def = 5): ParamDef => ({ id, label, min: 0, max: 10, def, unit: 'knob', step: 0.1 });
const db = (id: string, label: string, def = 0, min = -24, max = 12): ParamDef => ({ id, label, min, max, def, unit: 'dB', step: 0.1 });
const pct = (id: string, label: string, def = 0.5): ParamDef => ({ id, label, min: 0, max: 1, def, unit: '%', step: 0.01 });
const hz = (id: string, label: string, def: number, min: number, max: number): ParamDef => ({ id, label, min, max, def, unit: 'Hz', log: true, step: 1 });
const ms = (id: string, label: string, def: number, min: number, max: number): ParamDef => ({ id, label, min, max, def, unit: 'ms', log: true, step: 1 });
const choice = (id: string, label: string, options: string[], def = 0, values?: number[]): ParamDef =>
  ({ id, label, min: values ? Math.min(...values) : 0, max: values ? Math.max(...values) : options.length - 1, def, unit: '', step: 1, options, values });
const SYNC = ['Off', '1/1', '1/2', '1/2 dot', '1/2 trip', '1/4', '1/4 dot', '1/4 trip', '1/8', '1/8 dot', '1/8 trip', '1/16'];
const sync = (def = 0): ParamDef => choice('sync', 'Sync', SYNC, def);
const toggle = (id: string, label: string, off: string, on: string, def = 0): ParamDef => choice(id, label, [off, on], def);

const NAM_PARAMS = (mix = 1): ParamDef[] => [
  db('input', 'Input', 0, -24, 24), { ...db('bass', 'Bass', 0, -12, 12) }, db('mid', 'Mid', 0, -12, 12), db('treble', 'Treble', 0, -12, 12),
  db('presence', 'Presence', 0, -12, 12), db('output', 'Output', 0, -40, 24), pct('mix', 'Mix', mix),
];
const FDN_PARAMS = (decay: number, maxDecay: number): ParamDef[] => [
  { id: 'decay', label: 'Decay', min: 0.1, max: maxDecay, def: decay, unit: 's', log: true, step: 0.01 },
  ms('predelay', 'Predelay', 15, 0, 500), pct('size', 'Size', 0.5), hz('tone', 'Tone', 6500, 1000, 16000), hz('lowcut', 'Low Cut', 100, 20, 1000), pct('mix', 'Mix', 0.3),
];

export const RIG_BLOCKS: BlockDef[] = [
  // ------------------------------------------------------------------ drives
  { type: 1, key: 'od_mid', name: 'Mid Drive', category: 'drive', stereo: false, description: 'Mid-hump overdrive in the style of the green Tube Screamer: tight lows, smooth clipping, great in front of an amp.', params: [knob('drive', 'Drive'), knob('tone', 'Tone'), db('level', 'Level')] },
  { type: 2, key: 'od_clear', name: 'Clear Drive', category: 'drive', stereo: false, description: 'Transparent overdrive after the Klon Centaur: clean blend that fades as gain rises, active treble.', params: [knob('gain', 'Gain', 3), knob('treble', 'Treble'), db('output', 'Output')] },
  { type: 3, key: 'boost_clean', name: 'Clean Boost', category: 'drive', stereo: false, description: 'JFET preamp boost in the style of the EP Booster, with an optional bright switch.', params: [db('boost', 'Boost', 8, 0, 24), toggle('bright', 'Bright', 'Off', 'On')] },
  { type: 4, key: 'od_smooth', name: 'Smooth Drive', category: 'drive', stereo: false, description: 'Low-gain, open overdrive after the Timmy, with cut-only bass and treble.', params: [knob('gain', 'Gain', 4), knob('bass', 'Bass', 7), knob('treble', 'Treble', 6), db('volume', 'Volume'), choice('clip', 'Clip', ['Symmetric', 'Asymmetric', 'Open'])] },
  { type: 5, key: 'od_crunch', name: 'Crunch Drive', category: 'drive', stereo: false, description: 'MOSFET drive in the style of the OCD, from edge of breakup to amp-like crunch.', params: [knob('drive', 'Drive'), knob('tone', 'Tone'), db('volume', 'Volume'), toggle('mode', 'Mode', 'LP', 'HP', 1)] },
  { type: 6, key: 'dist_grit', name: 'Grit Distortion', category: 'drive', stereo: false, description: 'Op-amp distortion after the ProCo RAT: hard diode clipping and a sweepable filter.', params: [knob('distortion', 'Distortion'), knob('filter', 'Filter', 4), db('volume', 'Volume')] },
  { type: 7, key: 'fuzz_wall', name: 'Wall Fuzz', category: 'drive', stereo: false, description: 'Sustaining fuzz after the Big Muff: two clipping stages and the scooped tone control.', params: [knob('sustain', 'Sustain', 6), knob('tone', 'Tone'), db('volume', 'Volume')] },
  { type: 8, key: 'fuzz_round', name: 'Round Fuzz', category: 'drive', stereo: false, description: 'Two-transistor fuzz in the style of the Fuzz Face; cleans up when you roll back the guitar volume.', params: [knob('fuzz', 'Fuzz', 7), db('volume', 'Volume'), toggle('type', 'Type', 'Germanium', 'Silicon')] },
  { type: 9, key: 'fuzz_bender', name: 'Bender Fuzz', category: 'drive', stereo: false, description: 'Three-transistor British fuzz after the Tone Bender MkII: midrangey and aggressive.', params: [knob('attack', 'Attack', 7), db('level', 'Level')] },
  { type: 10, key: 'boost_treble', name: 'Treble Boost', category: 'drive', stereo: false, description: 'Germanium treble booster after the Rangemaster, for pushing a cranked amp.', params: [knob('range', 'Range', 6), db('level', 'Boost', 14, 0, 30)] },
  { type: 11, key: 'fuzz_octave', name: 'Octave Fuzz', category: 'drive', stereo: false, description: 'Octave-up fuzz in the spirit of the Octavia; best on the neck pickup above the 12th fret.', params: [knob('fuzz', 'Fuzz', 6), knob('octave', 'Octave', 6), db('level', 'Level')] },
  // ------------------------------------------------------------------ dynamics
  { type: 20, key: 'comp_squeeze', name: 'Squeeze Comp', category: 'dynamics', stereo: false, description: 'Pedal compressor after the Dyna Comp: snappy attack and country squash.', params: [knob('sensitivity', 'Sensitivity'), db('level', 'Level'), pct('mix', 'Mix', 1)] },
  { type: 21, key: 'comp_opto', name: 'Opto Comp', category: 'dynamics', stereo: false, description: 'Optical leveling amplifier after the LA-2A with program-dependent release.', params: [{ id: 'reduction', label: 'Peak Reduction', min: 0, max: 100, def: 40, unit: '', step: 1 }, db('gain', 'Gain', 0, -12, 24), pct('mix', 'Mix', 1)] },
  { type: 22, key: 'comp_studio', name: 'Studio Comp', category: 'dynamics', stereo: false, description: 'Clean VCA compressor with every control.', params: [db('threshold', 'Threshold', -20, -60, 0), { id: 'ratio', label: 'Ratio', min: 1, max: 20, def: 4, unit: '', step: 0.1, log: true }, ms('attack', 'Attack', 10, 0.1, 100), ms('release', 'Release', 120, 10, 2000), db('knee', 'Knee', 6, 0, 24), db('makeup', 'Makeup', 0, -12, 24), pct('mix', 'Mix', 1)] },
  { type: 23, key: 'comp_multi', name: 'Multiband Comp', category: 'dynamics', stereo: false, description: 'Three-band compressor with adjustable crossovers.', params: [hz('lowfreq', 'Low Freq', 200, 40, 1000), hz('highfreq', 'High Freq', 2500, 1000, 12000), db('lowthr', 'Low Thresh', -24, -60, 0), db('midthr', 'Mid Thresh', -24, -60, 0), db('highthr', 'High Thresh', -24, -60, 0), { id: 'ratio', label: 'Ratio', min: 1, max: 20, def: 3, unit: '', step: 0.1, log: true }, db('lowgain', 'Low Gain', 0, -12, 12), db('midgain', 'Mid Gain', 0, -12, 12), db('highgain', 'High Gain', 0, -12, 12), ms('attack', 'Attack', 10, 0.1, 100), ms('release', 'Release', 150, 10, 2000)] },
  { type: 24, key: 'gate_simple', name: 'Noise Gate', category: 'dynamics', stereo: false, description: 'Simple gate for hiss and hum between phrases.', params: [db('threshold', 'Threshold', -60, -96, 0), ms('decay', 'Decay', 100, 5, 2000)] },
  { type: 25, key: 'gate_hard', name: 'Hard Gate', category: 'dynamics', stereo: false, description: 'Fast, tight gate for high-gain rhythm in the style of the Horizon Precision Drive gate.', params: [db('threshold', 'Threshold', -55, -96, 0), ms('attack', 'Attack', 0.5, 0.05, 50), ms('hold', 'Hold', 40, 0, 500), ms('release', 'Release', 120, 5, 2000), db('range', 'Range', -80, -96, 0)] },
  // ------------------------------------------------------------------ eq
  { type: 30, key: 'eq_simple', name: 'Simple EQ', category: 'eq', stereo: false, description: 'Low and high shelves with a sweepable mid.', params: [db('low', 'Low', 0, -15, 15), db('mid', 'Mid', 0, -15, 15), hz('midfreq', 'Mid Freq', 800, 150, 6000), db('high', 'High', 0, -15, 15), db('level', 'Level')] },
  { type: 31, key: 'eq_param', name: 'Parametric EQ', category: 'eq', stereo: false, description: 'Low cut, shelves, a fully parametric mid band and high cut.', params: [hz('lowcut', 'Low Cut', 20, 20, 1000), hz('lowfreq', 'Low Freq', 120, 30, 1000), db('lowgain', 'Low Gain', 0, -15, 15), hz('midfreq', 'Mid Freq', 800, 80, 10000), { id: 'midq', label: 'Mid Q', min: 0.1, max: 10, def: 0.7, unit: '', step: 0.01, log: true }, db('midgain', 'Mid Gain', 0, -15, 15), hz('highfreq', 'High Freq', 4000, 1000, 16000), db('highgain', 'High Gain', 0, -15, 15), hz('highcut', 'High Cut', 20000, 1000, 20000), db('level', 'Level')] },
  { type: 32, key: 'eq_graphic', name: '10-Band EQ', category: 'eq', stereo: false, description: 'Octave graphic EQ from 31 Hz to 16 kHz.', params: [...['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'].map((f) => db(`b${f}`, f, 0, -15, 15)), db('level', 'Level')] },
  { type: 33, key: 'eq_cut', name: 'Low/High Cut', category: 'eq', stereo: false, description: 'Steep 24 dB/octave cuts to tame mud and fizz.', params: [hz('lowcut', 'Low Cut', 80, 20, 1000), hz('highcut', 'High Cut', 8000, 1000, 20000)] },
  { type: 34, key: 'eq_five', name: 'Five-Band EQ', category: 'eq', stereo: false, description: 'The five sliders of the classic Mesa graphic: 80, 240, 750, 2200 and 6600 Hz.', params: [...['80', '240', '750', '2.2k', '6.6k'].map((f) => db(`b${f}`, f, 0, -12, 12)), db('level', 'Level')] },
  // ------------------------------------------------------------------ volume
  { type: 40, key: 'volume', name: 'Volume Pedal', category: 'volume', stereo: false, description: 'Volume pedal with min/max and an audio taper; assign it to an expression pedal.', params: [{ ...pct('position', 'Position', 1), expression: true }, pct('min', 'Min', 0), pct('max', 'Max', 1), toggle('taper', 'Taper', 'Linear', 'Audio', 1)] },
  { type: 41, key: 'gain', name: 'Gain', category: 'volume', stereo: false, description: 'Clean level change.', params: [db('gain', 'Gain', 0, -60, 24)] },
  { type: 42, key: 'pan', name: 'Pan', category: 'volume', stereo: true, description: 'Places the signal in the stereo field.', params: [{ id: 'pan', label: 'Pan', min: -1, max: 1, def: 0, unit: '', step: 0.01 }] },
  { type: 43, key: 'width', name: 'Stereo Width', category: 'volume', stereo: true, description: 'Narrows or widens a stereo signal.', params: [{ id: 'width', label: 'Width', min: 0, max: 2, def: 1, unit: '%', step: 0.01 }] },
  // ------------------------------------------------------------------ modulation
  { type: 50, key: 'chorus', name: 'Chorus', category: 'modulation', stereo: true, description: 'Stereo bucket-brigade style chorus.', params: [hz('rate', 'Rate', 0.8, 0.05, 10), pct('depth', 'Depth', 0.5), ms('delay', 'Delay', 8, 1, 30), hz('tone', 'Tone', 8000, 800, 20000), pct('mix', 'Mix', 0.5)] },
  { type: 51, key: 'chorus_dim', name: 'Dimension', category: 'modulation', stereo: true, description: 'Subtle widening chorus after the Roland Dimension D, four modes.', params: [choice('mode', 'Mode', ['1', '2', '3', '4'], 2, [1, 2, 3, 4]), pct('mix', 'Mix', 0.6)] },
  { type: 52, key: 'flanger', name: 'Flanger', category: 'modulation', stereo: true, description: 'Through-zero style jet flanger with feedback.', params: [hz('rate', 'Rate', 0.3, 0.02, 8), pct('depth', 'Depth', 0.7), ms('manual', 'Manual', 1.5, 0.1, 8), { id: 'feedback', label: 'Feedback', min: -0.95, max: 0.95, def: 0.5, unit: '%', step: 0.01 }, pct('mix', 'Mix', 0.5)] },
  { type: 53, key: 'phaser', name: 'Phaser', category: 'modulation', stereo: true, description: 'Stereo phaser with 2 to 12 stages and feedback.', params: [hz('rate', 'Rate', 0.5, 0.02, 10), pct('depth', 'Depth', 0.8), pct('feedback', 'Feedback', 0.4), choice('stages', 'Stages', ['2', '4', '6', '8', '10', '12'], 6, [2, 4, 6, 8, 10, 12]), pct('mix', 'Mix', 0.5)] },
  { type: 54, key: 'phaser_script', name: 'Script Phase', category: 'modulation', stereo: false, description: 'One-knob four-stage phaser in the style of the MXR Phase 90, script or block logo voicing.', params: [pct('speed', 'Speed', 0.6), toggle('feedback', 'Voicing', 'Script', 'Block')] },
  { type: 55, key: 'vibe', name: 'Vibe', category: 'modulation', stereo: false, description: 'Lamp-driven phase/vibrato after the Uni-Vibe.', params: [pct('speed', 'Speed', 0.4), pct('intensity', 'Intensity', 0.7), toggle('mode', 'Mode', 'Chorus', 'Vibrato'), db('level', 'Level')] },
  { type: 56, key: 'tremolo', name: 'Tremolo', category: 'modulation', stereo: true, description: 'Bias, optical, harmonic or panning tremolo, with tempo sync.', params: [hz('rate', 'Rate', 4, 0.1, 20), pct('depth', 'Depth', 0.6), choice('shape', 'Shape', ['Sine', 'Triangle', 'Square']), choice('mode', 'Mode', ['Bias', 'Optical', 'Harmonic', 'Pan']), sync()] },
  { type: 57, key: 'rotary', name: 'Rotary', category: 'modulation', stereo: true, description: 'Rotating speaker with horn and drum, ramping between slow and fast.', params: [toggle('speed', 'Speed', 'Slow', 'Fast'), { id: 'balance', label: 'Balance', min: -1, max: 1, def: 0, unit: '', step: 0.01 }, knob('drive', 'Drive', 2), pct('width', 'Width', 0.8), pct('mix', 'Mix', 1)] },
  { type: 58, key: 'ringmod', name: 'Ring Mod', category: 'modulation', stereo: false, description: 'Ring modulator for bells and robots.', params: [hz('freq', 'Frequency', 440, 1, 4000), pct('mix', 'Mix', 0.5)] },
  // ------------------------------------------------------------------ delay
  { type: 60, key: 'delay_digital', name: 'Digital Delay', category: 'delay', stereo: true, timeBased: true, description: 'Clean repeats with cuts in the feedback path.', params: [ms('time', 'Time', 380, 1, 2500), pct('feedback', 'Feedback', 0.35), pct('mix', 'Mix', 0.35), sync(), hz('lowcut', 'Low Cut', 80, 20, 1000), hz('highcut', 'High Cut', 9000, 1000, 20000)] },
  { type: 61, key: 'delay_analog', name: 'Analog Delay', category: 'delay', stereo: true, timeBased: true, description: 'Dark, warm bucket-brigade repeats that self-oscillate musically.', params: [ms('time', 'Time', 320, 20, 900), { ...pct('feedback', 'Feedback', 0.4), max: 1.1 }, pct('mix', 'Mix', 0.35), pct('tone', 'Tone', 0.5), pct('mod', 'Mod', 0.3), sync()] },
  { type: 62, key: 'delay_tape', name: 'Tape Echo', category: 'delay', stereo: true, timeBased: true, description: 'Tape echo with wow, flutter and saturation, after the Echoplex and Space Echo.', params: [ms('time', 'Time', 350, 40, 2000), { ...pct('feedback', 'Feedback', 0.4), max: 1.1 }, pct('mix', 'Mix', 0.35), pct('wow', 'Wow', 0.3), pct('flutter', 'Flutter', 0.3), pct('saturation', 'Saturation', 0.4), hz('tone', 'Tone', 5500, 1000, 16000), sync()] },
  { type: 63, key: 'delay_pingpong', name: 'Ping Pong', category: 'delay', stereo: true, timeBased: true, description: 'Repeats that bounce between left and right.', params: [ms('time', 'Time', 420, 1, 2500), pct('feedback', 'Feedback', 0.45), pct('mix', 'Mix', 0.35), pct('spread', 'Spread', 1), sync()] },
  { type: 64, key: 'delay_dual', name: 'Dual Delay', category: 'delay', stereo: true, timeBased: true, description: 'Independent left and right delay times.', params: [ms('timel', 'Time L', 300, 1, 2500), ms('timer', 'Time R', 450, 1, 2500), pct('feedback', 'Feedback', 0.35), pct('mix', 'Mix', 0.35), hz('highcut', 'High Cut', 8000, 1000, 18000)] },
  { type: 65, key: 'delay_reverse', name: 'Reverse Delay', category: 'delay', stereo: true, timeBased: true, description: 'Plays each slice of what you played backwards.', params: [ms('time', 'Time', 700, 100, 2000), pct('feedback', 'Feedback', 0.3), pct('mix', 'Mix', 0.45)] },
  { type: 66, key: 'delay_ducked', name: 'Ducked Delay', category: 'delay', stereo: true, timeBased: true, description: 'Repeats duck while you play and bloom when you stop.', params: [ms('time', 'Time', 420, 1, 2500), pct('feedback', 'Feedback', 0.4), pct('mix', 'Mix', 0.45), db('threshold', 'Threshold', -30, -70, 0), db('amount', 'Ducking', -18, -60, 0), sync()] },
  { type: 67, key: 'delay_multitap', name: 'Multi-Tap', category: 'delay', stereo: true, timeBased: true, description: 'Up to eight taps across the stereo field.', params: [ms('time', 'Time', 600, 20, 2500), { id: 'taps', label: 'Taps', min: 2, max: 8, def: 4, unit: '', step: 1 }, pct('feedback', 'Feedback', 0.25), pct('mix', 'Mix', 0.35), pct('spread', 'Spread', 0.8), pct('decay', 'Decay', 0.7)] },
  // ------------------------------------------------------------------ reverb
  { type: 70, key: 'rev_room', name: 'Room', category: 'reverb', stereo: true, timeBased: true, description: 'Small, natural room with early reflections.', params: FDN_PARAMS(1.2, 6) },
  { type: 71, key: 'rev_hall', name: 'Hall', category: 'reverb', stereo: true, timeBased: true, description: 'Big concert hall with slow modulation.', params: FDN_PARAMS(3.5, 20) },
  { type: 72, key: 'rev_plate', name: 'Plate', category: 'reverb', stereo: true, timeBased: true, description: 'Dense, bright studio plate.', params: FDN_PARAMS(2.2, 12) },
  { type: 73, key: 'rev_spring', name: 'Spring', category: 'reverb', stereo: true, timeBased: true, description: 'Amp-style spring tank with drip.', params: [pct('decay', 'Dwell', 0.5), hz('tone', 'Tone', 4500, 1500, 9000), pct('mix', 'Mix', 0.35), pct('drip', 'Drip', 0.5)] },
  { type: 74, key: 'rev_chamber', name: 'Chamber', category: 'reverb', stereo: true, timeBased: true, description: 'Echo chamber: dense and warm.', params: FDN_PARAMS(1.8, 10) },
  { type: 75, key: 'rev_shimmer', name: 'Shimmer', category: 'reverb', stereo: true, timeBased: true, description: 'Hall with pitch-shifted feedback for ambient pads.', params: [{ id: 'decay', label: 'Decay', min: 0.5, max: 20, def: 6, unit: 's', log: true, step: 0.01 }, ms('predelay', 'Predelay', 30, 0, 500), pct('shimmer', 'Shimmer', 0.5), choice('interval', 'Interval', ['-12', '+5', '+7', '+12', '+19', '+24'], 12, [-12, 5, 7, 12, 19, 24]), hz('tone', 'Tone', 6000, 1000, 16000), pct('mix', 'Mix', 0.35)] },
  { type: 76, key: 'rev_ambient', name: 'Ambient', category: 'reverb', stereo: true, timeBased: true, description: 'Huge, modulated wash that goes on and on.', params: [...FDN_PARAMS(12, 60).map((p) => (p.id === 'tone' ? { ...p, def: 5000 } : p.id === 'mix' ? { ...p, def: 0.4 } : p))] },
  // ------------------------------------------------------------------ pitch
  { type: 80, key: 'pitch_whammy', name: 'Whammy', category: 'pitch', stereo: false, description: 'Expression-controlled pitch bend in the style of the DigiTech Whammy, under 10 ms.', params: [{ ...pct('position', 'Position', 0), expression: true }, { id: 'heel', label: 'Heel', min: -24, max: 24, def: 0, unit: 'st', step: 1 }, { id: 'toe', label: 'Toe', min: -24, max: 24, def: 12, unit: 'st', step: 1 }, pct('mix', 'Mix', 1)] },
  { type: 81, key: 'pitch_simple', name: 'Pitch Shift', category: 'pitch', stereo: false, description: 'Fixed interval shift with fine detune; mix in for octaves and doubling.', params: [{ id: 'interval', label: 'Interval', min: -24, max: 24, def: 12, unit: 'st', step: 1 }, { id: 'cents', label: 'Cents', min: -50, max: 50, def: 0, unit: 'ct', step: 1 }, pct('mix', 'Mix', 0.5)] },
  { type: 82, key: 'pitch_harmony', name: 'Harmony', category: 'pitch', stereo: false, description: 'Key-aware harmonizer for single-note lines.', params: [choice('key', 'Key', ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'], 4), choice('scale', 'Scale', ['Major', 'Minor', 'Dorian', 'Mixolydian', 'Harmonic minor', 'Pentatonic major', 'Pentatonic minor']), choice('voice', 'Voice', ['Octave down', '6th down', '5th down', '4th down', '3rd down', '3rd up', '4th up', '5th up', '6th up', 'Octave up'], 2, [-7, -5, -4, -3, -2, 2, 3, 4, 5, 7]), pct('mix', 'Mix', 0.5)] },
  { type: 83, key: 'pitch_capo', name: 'Poly Capo', category: 'pitch', stereo: false, description: 'Polyphonic transposition for chords: play in a new key without retuning.', params: [{ id: 'semitones', label: 'Semitones', min: -12, max: 12, def: 2, unit: 'st', step: 1 }, pct('mix', 'Mix', 1)] },
  { type: 84, key: 'octaver', name: 'Octaver', category: 'pitch', stereo: false, description: 'Analog-style octave divider after the Boss OC-2: one and two octaves down.', params: [pct('oct1', 'Octave 1', 0.8), pct('oct2', 'Octave 2', 0.3), pct('dry', 'Dry', 1)] },
  // ------------------------------------------------------------------ filter and wah
  { type: 90, key: 'env_filter', name: 'Envelope Filter', category: 'filter', stereo: false, description: 'Funky auto-wah after the Mu-Tron III.', params: [pct('sensitivity', 'Sensitivity', 0.6), toggle('range', 'Range', 'Low', 'High'), { id: 'q', label: 'Q', min: 0.5, max: 12, def: 4, unit: '', step: 0.1, log: true }, choice('mode', 'Mode', ['Low pass', 'Band pass', 'High pass'], 1), toggle('direction', 'Direction', 'Up', 'Down'), pct('mix', 'Mix', 1)] },
  { type: 91, key: 'synth_filter', name: 'Synth Filter', category: 'filter', stereo: false, description: 'Resonant ladder filter with envelope and LFO.', params: [hz('cutoff', 'Cutoff', 800, 40, 12000), pct('resonance', 'Resonance', 0.5), pct('envelope', 'Envelope', 0.5), hz('lforate', 'LFO Rate', 1, 0.05, 20), pct('lfodepth', 'LFO Depth', 0), pct('mix', 'Mix', 1)] },
  { type: 92, key: 'wah_classic', name: 'Classic Wah', category: 'wah', stereo: false, description: 'Inductor wah in the style of the Cry Baby.', params: [{ ...pct('position', 'Position', 0.5), expression: true }, { id: 'q', label: 'Q', min: 1, max: 15, def: 5, unit: '', step: 0.1 }, db('level', 'Level', 0, -12, 12)] },
  { type: 93, key: 'wah_vintage', name: 'Vintage Wah', category: 'wah', stereo: false, description: 'Smoother, vocal wah after the original Vox.', params: [{ ...pct('position', 'Position', 0.5), expression: true }, { id: 'q', label: 'Q', min: 1, max: 15, def: 3.5, unit: '', step: 0.1 }, db('level', 'Level', 0, -12, 12)] },
  // ------------------------------------------------------------------ captures and cabs
  { type: 100, key: 'nam_amp', name: 'Amp', category: 'amp', stereo: false, nam: 'amp', description: 'A NAM capture of an amp head or combo (no cab). Follow it with a cab.', params: NAM_PARAMS() },
  { type: 101, key: 'nam_preamp', name: 'Preamp', category: 'preamp', stereo: false, nam: 'preamp', description: 'A NAM capture of a preamp (no power amp or cab).', params: NAM_PARAMS() },
  { type: 102, key: 'nam_pedal', name: 'Pedal Capture', category: 'capture', stereo: false, nam: 'pedal', description: 'A NAM capture of a real pedal or outboard unit.', params: NAM_PARAMS() },
  { type: 103, key: 'nam_cab', name: 'Cab Capture', category: 'cab', stereo: false, nam: 'cab', description: 'A NAM capture of a speaker cabinet (instead of an IR).', params: NAM_PARAMS() },
  { type: 104, key: 'nam_full', name: 'Full Rig', category: 'amp', stereo: false, nam: 'full-rig', description: 'A NAM capture of a whole rig: amp, cab and mic.', params: NAM_PARAMS() },
  { type: 105, key: 'cab_ir', name: 'Cab (IR)', category: 'cab', stereo: false, irSlots: 1, description: 'Speaker cabinet from an impulse response, with cuts.', params: [pct('mix', 'Mix', 1), hz('lowcut', 'Low Cut', 80, 20, 1000), hz('highcut', 'High Cut', 9000, 1000, 20000), db('level', 'Level', 0, -40, 24)] },
  { type: 106, key: 'cab_dual', name: 'Dual Cab', category: 'cab', stereo: true, irSlots: 2, description: 'Two IRs blended and panned, with a delay on the second for mic distance.', params: [db('levela', 'Level A', 0, -40, 12), db('levelb', 'Level B', 0, -40, 12), { id: 'pana', label: 'Pan A', min: -1, max: 1, def: -0.5, unit: '', step: 0.01 }, { id: 'panb', label: 'Pan B', min: -1, max: 1, def: 0.5, unit: '', step: 0.01 }, { id: 'delayb', label: 'Delay B', min: 0, max: 5, def: 0, unit: 'ms', step: 0.01 }, hz('lowcut', 'Low Cut', 80, 20, 1000), hz('highcut', 'High Cut', 9000, 1000, 20000)] },
  { type: 107, key: 'amp_cab', name: 'Amp + Cab', category: 'amp', stereo: false, nam: 'amp', irSlots: 1, description: 'A NAM amp and an IR cab in one block.', params: [...NAM_PARAMS().slice(0, 6), pct('cabmix', 'Cab Mix', 1), hz('lowcut', 'Low Cut', 80, 20, 1000), hz('highcut', 'High Cut', 9000, 1000, 20000)] },
  // ------------------------------------------------------------------ looper
  { type: 110, key: 'looper', name: 'Looper', category: 'looper', stereo: true, timeBased: true, liveOnly: true, description: '30-second stereo looper with overdub, undo, half speed and reverse.', params: [db('level', 'Level', 0, -40, 12)] },
];

export const BLOCK_BY_TYPE = new Map(RIG_BLOCKS.map((b) => [b.type, b]));
export const BLOCK_BY_KEY = new Map(RIG_BLOCKS.map((b) => [b.key, b]));

export const CATEGORY_LABELS: Record<BlockCategory, string> = {
  drive: 'Drive', dynamics: 'Dynamics', eq: 'EQ', volume: 'Volume & Pan', modulation: 'Modulation', delay: 'Delay', reverb: 'Reverb',
  pitch: 'Pitch', filter: 'Filter', wah: 'Wah', amp: 'Amp', preamp: 'Preamp', cab: 'Cab', capture: 'Pedal capture', looper: 'Looper',
};

export const CATEGORY_ORDER: BlockCategory[] = ['amp', 'preamp', 'cab', 'capture', 'drive', 'dynamics', 'eq', 'wah', 'filter', 'pitch', 'modulation', 'delay', 'reverb', 'volume', 'looper'];

export function defaultParams(def: BlockDef): Record<string, number> {
  return Object.fromEntries(def.params.map((p) => [p.id, p.def]));
}

/** formats a value for a knob label */
export function formatParam(p: ParamDef, v: number): string {
  if (p.options) {
    const i = p.values ? p.values.indexOf(v) : Math.round(v);
    return p.options[i] ?? String(v);
  }
  switch (p.unit) {
    case 'dB': return `${v > 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)} dB`;
    case 'Hz': return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${v < 10 ? v.toFixed(2) : Math.round(v)} Hz`;
    case 'ms': return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`;
    case 's': return `${v.toFixed(v < 10 ? 1 : 0)} s`;
    case '%': return `${Math.round(v * 100)}%`;
    case 'st': return `${v > 0 ? '+' : ''}${Math.round(v)} st`;
    case 'ct': return `${v > 0 ? '+' : ''}${Math.round(v)} ct`;
    case 'knob': return v.toFixed(1);
    default: return Math.abs(v) < 10 ? v.toFixed(2).replace(/\.?0+$/, '') : v.toFixed(0);
  }
}

/** knob position 0..1 for a value, and back (log knobs for frequencies and times) */
export function paramToUnit(p: ParamDef, v: number): number {
  if (p.options && p.values) return Math.max(0, p.values.indexOf(v)) / Math.max(1, p.values.length - 1);
  if (p.log && p.min > 0) return Math.log(v / p.min) / Math.log(p.max / p.min);
  if (p.log && p.min === 0) { const lo = Math.max(0.01, p.max / 1000); return v <= lo ? 0 : Math.log(v / lo) / Math.log(p.max / lo); }
  return (v - p.min) / (p.max - p.min);
}
export function unitToParam(p: ParamDef, u: number): number {
  u = Math.min(1, Math.max(0, u));
  let v: number;
  if (p.options && p.values) return p.values[Math.round(u * (p.values.length - 1))];
  if (p.log && p.min > 0) v = p.min * Math.pow(p.max / p.min, u);
  else if (p.log && p.min === 0) { const lo = Math.max(0.01, p.max / 1000); v = u <= 0 ? 0 : lo * Math.pow(p.max / lo, u); }
  else v = p.min + u * (p.max - p.min);
  const step = p.step ?? 0;
  if (step > 0) v = Math.round(v / step) * step;
  return Math.min(p.max, Math.max(p.min, +v.toFixed(4)));
}

export type Instrument = 'guitar' | 'bass' | 'drums' | 'keys' | 'vocals' | 'other';

export type SongFormat = 'score' | 'text';

export type SourceKind = 'local' | 'upload' | 'demo' | 'songsterr' | 'ultimate-guitar';

export interface TrackSummary {
  index: number;
  name: string;
  instrument: Instrument;
  program: number;
  isPercussion: boolean;
  strings: number;
  /** MIDI note numbers, highest string first (alphaTab order). */
  tuning: number[];
  tuningName: string | null;
  capo: number;
}

export interface SongSource {
  kind: SourceKind;
  /** Absolute path for local files, provider id for online sources. */
  ref: string;
  url?: string;
  /** e.g. "Chords", "Tabs", "Bass Tabs" for Ultimate Guitar. */
  variant?: string;
  rating?: number;
  votes?: number;
}

export interface SongRecord {
  id: string;
  title: string;
  artist: string;
  album: string;
  format: SongFormat;
  /** File name inside the data dir (score) or text payload id. */
  file: string;
  /** Original file extension, e.g. gp5, gp, musicxml. */
  ext: string;
  source: SongSource;
  tracks: TrackSummary[];
  instruments: Instrument[];
  tempo: number | null;
  bars: number;
  hasLyrics: boolean;
  hash: string;
  addedAt: number;
  updatedAt: number;
  missing?: boolean;
  /** mtime of the source file when it was last imported (local files). */
  fileMtime?: number;
  favorite?: boolean;
  lastOpenedAt?: number;
  openCount?: number;
  /** Player state remembered per song. */
  practice?: PracticeState;
  warnings?: string[];
}

export interface PracticeState {
  speed?: number;
  loop?: { startBar: number; endBar: number } | null;
  mixer?: Record<string, { volume: number; mute: boolean; solo: boolean }>;
  masterVolume?: number;
  transpose?: number;
  pitchShift?: number;
  visibleTracks?: number[];
  view?: 'tab' | 'notation' | 'both';
  capo?: number;
}

export interface TextTab {
  /** Raw Ultimate Guitar "wiki" markup with [ch] and [tab] tags. */
  content: string;
  capo: number;
  tuning: string | null;
  key: string | null;
  /** Chord name -> list of fingerings (frets low E to high E, -1 = muted). */
  shapes: Record<string, ChordShape[]>;
  type: string;
}

export interface ChordShape {
  frets: number[];
  fingers?: number[];
  baseFret?: number;
}

export interface OnlineResult {
  source: 'songsterr' | 'ultimate-guitar';
  /** Provider-specific id used to open the result. */
  ref: string;
  title: string;
  artist: string;
  variant: string;
  instruments: Instrument[];
  tuningName?: string | null;
  rating?: number;
  votes?: number;
  url: string;
  /** Library song id when this result is already saved. */
  savedId?: string;
}

export interface OnlineSearchResponse {
  source: OnlineResult['source'];
  results: OnlineResult[];
  error?: string;
}

export interface Prefs {
  instrument: Instrument | 'all';
  theme: 'dark' | 'light' | 'system';
  leftHanded: boolean;
  referencePitch: number;
  countInBars: number;
  followCursor: boolean;
  sources: { songsterr: boolean; ultimateGuitar: boolean };
  autoSaveOnline: boolean;
  libraryDir: string;
  zoom: number;
  layout: 'page' | 'horizontal';
  demosSeeded?: boolean;
}

export const defaultPrefs: Prefs = {
  instrument: 'all',
  theme: 'dark',
  leftHanded: false,
  referencePitch: 440,
  countInBars: 1,
  followCursor: true,
  sources: { songsterr: true, ultimateGuitar: true },
  autoSaveOnline: true,
  libraryDir: '',
  zoom: 1,
  layout: 'page',
};

export interface StatusResponse {
  version: string;
  mode: 'desktop' | 'server';
  needsSetup: boolean;
  authenticated: boolean;
  libraryDir: string;
  songCount: number;
}

// What the AI worker's `transcribe` command returns (times in seconds).
export interface AiNote {
  start: number;
  end: number;
  pitch: number;
  velocity: number;
  confidence: number;
  /** pitch contour, semitones off `pitch`, sampled across the note */
  bend: number[];
  /** palm mute (guitar) */
  pm?: boolean;
}

export interface AiDrumHit {
  time: number;
  piece: 'kick' | 'snare' | 'hihat' | 'hihat-open' | 'crash' | 'ride' | 'tom-high' | 'tom-mid' | 'tom-low';
  velocity: number;
  confidence: number;
  ghost?: boolean;
}

export interface AiTrack {
  instrument: 'guitar' | 'bass' | 'drums' | 'piano' | 'vocals' | 'other';
  stem: string;
  method: string;
  notes?: AiNote[];
  hits?: AiDrumHit[];
  tone?: 'clean' | 'distorted';
}

export interface AiResult {
  input: string;
  title?: string | null;
  duration: number;
  beats: number[];
  downbeats: number[];
  beatMethod?: string;
  sections: { time: number; label: string }[];
  tracks: AiTrack[];
  lyrics: { start: number; end: number; text: string }[] | null;
  stems: Record<string, string>;
  device?: string;
}

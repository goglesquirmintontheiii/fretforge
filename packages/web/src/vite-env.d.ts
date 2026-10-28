/// <reference types="vite/client" />

interface NativeEngineStatus {
  available: boolean;
  running: boolean;
  reason?: string;
  backend?: string;
  client?: string;
  sampleRate?: number;
  bufferSize?: number;
  latencyMs?: number;
  rigLatencyMs?: number;
}

interface NativePorts { sources: string[]; sinks: string[]; physicalSources?: string[]; physicalSinks?: string[]; midiSources?: string[] }

interface Window {
  fretforgeDesktop?: {
    chooseFolder(current?: string): Promise<string | null>;
    openExternal(url: string): Promise<void>;
    showItemInFolder(path: string): Promise<void>;
    /** the native low-latency rig engine (JACK / PipeWire) */
    engine?: {
      status(): Promise<NativeEngineStatus>;
      start(opts: { connect?: boolean; inputs?: string[]; outputs?: string[]; latency?: number }): Promise<NativeEngineStatus>;
      stop(): Promise<void>;
      ports(): Promise<NativePorts>;
      connections(): Promise<Record<'in' | 'out_L' | 'out_R' | 'midi_in' | 'phones_L' | 'phones_R', string[] | undefined>>;
      connect(ours: 'in' | 'out_L' | 'out_R' | 'midi_in' | 'phones_L' | 'phones_R', other: string, on: boolean): Promise<boolean>;
      loadGraph(desc: Float32Array, nams: { block: number; code: Int32Array; weights: Float32Array; gain: number }[], irs: { block: number; slot: number; data: Float32Array }[]): Promise<{ blocks: number; latency: number }>;
      control(op: string, a: number, b?: number, c?: number): void;
      meters(): Promise<{ input: number; output: number; load: number; xruns: number; tunerHz: number; blocks: number[]; states: number[]; midi: number[][] }>;
      measureLatency(): Promise<{ roundTripMs: number | null; message: string }>;
      /** the song player inside the engine (one clock with the rig) */
      playerSource(slot: number, a: Int16Array | null, b: Int16Array | null, scale: number): Promise<boolean>;
      playerClicks(frames: Float64Array, accent: Uint8Array): Promise<boolean>;
      playerCmd(op: 'mix' | 'offset' | 'play' | 'pause' | 'seek' | 'rate' | 'pitch' | 'master' | 'duration' | 'loop' | 'metronome' | 'clear', a?: number, b?: number, c?: number, d?: number): void;
      playerState(): Promise<{ running: boolean; frames?: number; playing?: boolean; counting?: boolean; ended?: number; peak?: number; sampleRate?: number; latency?: number }>;
      record(on: boolean): Promise<boolean>;
      takeRecording(): Promise<NativeRecording | null>;
    };
    /** embedded TONE3000 page */
    tone3000?: {
      setCapture(on: boolean): void;
      onStatus(cb: (s: { state: 'downloading' | 'imported' | 'failed'; name: string; added?: number; existing?: number; errors?: { name: string; message: string }[]; message?: string }) => void): () => void;
    };
  };
}

/** what the engine recorded since the last take: DI before the rig, the rig and the song, plus per-callback marks [frame, songFrames, rate, playing]* */
interface NativeRecording { di: Float32Array; rigL: Float32Array; rigR: Float32Array; songL: Float32Array; songR: Float32Array; dropped: number; marks: Float64Array; sampleRate: number }

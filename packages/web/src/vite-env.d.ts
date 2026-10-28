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
      connections(): Promise<Record<'in' | 'out_L' | 'out_R' | 'midi_in', string[] | undefined>>;
      connect(ours: 'in' | 'out_L' | 'out_R' | 'midi_in', other: string, on: boolean): Promise<boolean>;
      loadGraph(desc: Float32Array, nams: { block: number; code: Int32Array; weights: Float32Array; gain: number }[], irs: { block: number; slot: number; data: Float32Array }[]): Promise<{ blocks: number; latency: number }>;
      control(op: string, a: number, b?: number, c?: number): void;
      meters(): Promise<{ input: number; output: number; load: number; xruns: number; tunerHz: number; blocks: number[]; states: number[]; midi: number[][] }>;
      measureLatency(): Promise<{ roundTripMs: number | null; message: string }>;
    };
    /** embedded TONE3000 page */
    tone3000?: {
      setCapture(on: boolean): void;
      onStatus(cb: (s: { state: 'downloading' | 'imported' | 'failed'; name: string; added?: number; existing?: number; errors?: { name: string; message: string }[]; message?: string }) => void): () => void;
    };
  };
}

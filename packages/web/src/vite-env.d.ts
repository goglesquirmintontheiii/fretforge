/// <reference types="vite/client" />

interface NativeEngineStatus {
  available: boolean;
  running: boolean;
  reason?: string;
  backend?: string;
  sampleRate?: number;
  bufferSize?: number;
  latencyMs?: number;
}

interface Window {
  fretforgeDesktop?: {
    chooseFolder(current?: string): Promise<string | null>;
    openExternal(url: string): Promise<void>;
    showItemInFolder(path: string): Promise<void>;
    /** the native low-latency rig engine (JACK / PipeWire) */
    engine?: {
      status(): Promise<NativeEngineStatus>;
      start(opts: { input?: string; outputs?: string[] }): Promise<NativeEngineStatus>;
      stop(): Promise<void>;
      loadNam(code: Int32Array, weights: Float32Array, gain: number): Promise<void>;
      clearNam(): Promise<void>;
      loadIr(data: Float32Array | null): Promise<void>;
      setParam(id: number, value: number): void;
      meters(): Promise<{ input: number; output: number; load: number; xruns: number }>;
      measureLatency(): Promise<{ roundTripMs: number | null; message: string }>;
    };
  };
}

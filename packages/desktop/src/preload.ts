import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('fretforgeDesktop', {
  chooseFolder: (current?: string) => ipcRenderer.invoke('ff:chooseFolder', current),
  openExternal: (url: string) => ipcRenderer.invoke('ff:openExternal', url),
  showItemInFolder: (path: string) => ipcRenderer.invoke('ff:showItemInFolder', path),
  engine: {
    status: () => ipcRenderer.invoke('ff:engine:status'),
    start: (opts: object) => ipcRenderer.invoke('ff:engine:start', opts),
    stop: () => ipcRenderer.invoke('ff:engine:stop'),
    ports: () => ipcRenderer.invoke('ff:engine:ports'),
    connections: () => ipcRenderer.invoke('ff:engine:connections'),
    connect: (ours: string, other: string, on: boolean) => ipcRenderer.invoke('ff:engine:connect', ours, other, on),
    loadGraph: (desc: Float32Array, nams: unknown[], irs: unknown[]) => ipcRenderer.invoke('ff:engine:loadGraph', desc, nams, irs),
    control: (op: string, a: number, b?: number, c?: number) => ipcRenderer.send('ff:engine:control', op, a, b, c),
    meters: () => ipcRenderer.invoke('ff:engine:meters'),
    measureLatency: () => ipcRenderer.invoke('ff:engine:measureLatency'),
  },
  tone3000: {
    setCapture: (on: boolean) => ipcRenderer.send('ff:t3k:capture', on),
    onStatus: (cb: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on('ff:t3k:status', h);
      return () => { ipcRenderer.removeListener('ff:t3k:status', h); };
    },
  },
});

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('fretforgeDesktop', {
  chooseFolder: (current?: string) => ipcRenderer.invoke('ff:chooseFolder', current),
  openExternal: (url: string) => ipcRenderer.invoke('ff:openExternal', url),
  showItemInFolder: (path: string) => ipcRenderer.invoke('ff:showItemInFolder', path),
  engine: {
    status: () => ipcRenderer.invoke('ff:engine:status'),
    start: (opts: object) => ipcRenderer.invoke('ff:engine:start', opts),
    stop: () => ipcRenderer.invoke('ff:engine:stop'),
    loadNam: (code: Int32Array, weights: Float32Array, gain: number) => ipcRenderer.invoke('ff:engine:loadNam', code, weights, gain),
    clearNam: () => ipcRenderer.invoke('ff:engine:clearNam'),
    loadIr: (data: Float32Array | null) => ipcRenderer.invoke('ff:engine:loadIr', data),
    setParam: (id: number, value: number) => ipcRenderer.send('ff:engine:setParam', id, value),
    meters: () => ipcRenderer.invoke('ff:engine:meters'),
    measureLatency: () => ipcRenderer.invoke('ff:engine:measureLatency'),
  },
});

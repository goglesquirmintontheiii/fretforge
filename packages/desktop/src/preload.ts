import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('fretforgeDesktop', {
  chooseFolder: (current?: string) => ipcRenderer.invoke('ff:chooseFolder', current),
  openExternal: (url: string) => ipcRenderer.invoke('ff:openExternal', url),
  showItemInFolder: (path: string) => ipcRenderer.invoke('ff:showItemInFolder', path),
});

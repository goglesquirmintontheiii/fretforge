/// <reference types="vite/client" />
interface Window {
  fretforgeDesktop?: {
    chooseFolder(current?: string): Promise<string | null>;
    openExternal(url: string): Promise<void>;
    showItemInFolder(path: string): Promise<void>;
  };
}

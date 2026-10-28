// "yt-dlp isn't installed" with a one-click install, shown wherever YouTube audio is needed.
import { useEffect, useState } from 'react';
import { api, type YtdlpStatus } from '../api';
import { useApp } from '../lib/app';

/** Checks for yt-dlp; renders nothing when it's there. `recheck` changes force a new check. */
export function YtdlpInstall({ recheck = 0, onInstalled }: { recheck?: number; onInstalled?: () => void }) {
  const { user, toast } = useApp();
  const [st, setSt] = useState<YtdlpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.ytdlp().then(setSt).catch(() => {}); }, [recheck]);
  if (!st || st.found) return null;
  const owner = user?.role === 'owner';
  return (
    <div className="ytdlp-missing" role="status">
      <span>yt-dlp isn’t installed. Fretforge uses it to get the audio from YouTube.</span>
      {owner && st.canInstall ? (
        <button className="btn sm primary" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            const r = await api.installYtdlp();
            setSt(r);
            toast(`yt-dlp ${r.version ?? ''} is installed`);
            onInstalled?.();
          } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
        }}>{busy ? <><span className="spinner" /> Downloading…</> : 'Install yt-dlp'}</button>
      ) : <span className="faint">{st.reason ?? 'Ask the owner of this server to install it.'}</span>}
    </div>
  );
}

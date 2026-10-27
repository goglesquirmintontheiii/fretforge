import { useEffect, useState } from 'react';
import type { SongRecord } from '@fretforge/shared';
import { api } from '../api';
import { useApp } from '../lib/app';
import { ScorePlayer } from './ScorePlayer';
import { TextTabView } from './TextTabView';

/** A song opened from a share link: read-only, no account needed. */
export function SharedSongView({ token }: { token: string }) {
  const { toast } = useApp();
  const [song, setSong] = useState<SongRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.shared(token).then((s) => { setSong(s); document.title = `${s.title}${s.artist ? ' – ' + s.artist : ''} · Fretforge`; }).catch((e) => setError(e.message));
  }, [token]);
  if (error) return <div className="authwrap"><div className="card authcard"><h2>This link doesn’t work</h2><p className="muted">{error}</p></div></div>;
  if (!song) return <div className="authwrap"><span className="spinner" /></div>;
  return (
    <div className="shell" style={{ gridTemplateRows: '1fr' }}>
      <main className="main">
        {song.format === 'text'
          ? <TextTabView song={song} onClose={() => {}} onPatch={() => {}} loadText={() => api.sharedText(token)} readOnly />
          : <ScorePlayer song={song} onClose={() => {}} onPatch={() => {}} onToast={toast} readOnly loadFile={() => api.sharedFile(token)} />}
      </main>
    </div>
  );
}

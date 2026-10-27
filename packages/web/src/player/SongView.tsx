import { useCallback, useEffect, useRef, useState } from 'react';
import type { PracticeState, SongRecord } from '@fretforge/shared';
import { api } from '../api';
import { useApp } from '../lib/app';
import { ScorePlayer } from './ScorePlayer';
import { TextTabView } from './TextTabView';

export function SongView({ id, onClose, edit }: { id: string; onClose: () => void; edit?: boolean }) {
  const { toast } = useApp();
  const [song, setSong] = useState<SongRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Partial<SongRecord> & { practice?: PracticeState }>({});
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api.song(id).then((s) => {
      setSong(s);
      document.title = `${s.title}${s.artist ? ' – ' + s.artist : ''} · Fretforge`;
      api.opened(id).catch(() => {});
    }).catch((e) => setError(e.message));
  }, [id]);

  const flush = useCallback(() => {
    const p = pending.current;
    pending.current = {};
    if (Object.keys(p).length) api.patchSong(id, p).catch(() => {});
  }, [id]);

  // Batch practice-state saves (speed, loop, mixer…) so dragging a slider doesn't flood the server
  const onPatch = useCallback((p: Partial<SongRecord>) => {
    pending.current = { ...pending.current, ...p, practice: { ...(pending.current.practice ?? {}), ...(p.practice ?? {}) } };
    if (!p.practice) delete pending.current.practice;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 800);
  }, [flush]);

  useEffect(() => () => { window.clearTimeout(timer.current); flush(); }, [flush]);

  if (error) return <div className="page"><div className="error">{error}</div><button className="btn" onClick={onClose}>Back to library</button></div>;
  if (!song) return <div className="page"><div className="empty"><span className="spinner" /></div></div>;
  if (song.format === 'text') return <TextTabView song={song} onClose={onClose} onPatch={onPatch} />;
  return <ScorePlayer song={song} onClose={onClose} onPatch={onPatch} onToast={toast} edit={edit} onSongChange={(s) => setSong(s)} />;
}

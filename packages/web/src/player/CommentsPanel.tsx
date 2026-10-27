import { useEffect, useState } from 'react';
import type { Comment } from '@fretforge/shared';
import { api } from '../api';
import { useApp } from '../lib/app';
import { Icon } from '../components/icons';

function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

/** Comments on the song or pinned to a bar. Clicking a bar comment jumps there. */
export function CommentsPanel({ songId, bar, onGoto, revision }: { songId: string; bar: number; onGoto: (bar: number) => void; revision: number }) {
  const { user, toast } = useApp();
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [text, setText] = useState('');
  const [pin, setPin] = useState(true);
  const load = () => api.comments(songId).then((r) => setComments(r.comments)).catch(() => setComments([]));
  useEffect(() => { load(); }, [songId]); // eslint-disable-line react-hooks/exhaustive-deps
  const canWrite = user?.role !== 'viewer';
  return (
    <div className="side-pane">
      {comments === null ? <span className="spinner" /> : comments.length === 0 ? <p className="muted" style={{ margin: 0 }}>No comments yet.</p> : (
        <div className="comments">
          {comments.map((c) => (
            <div key={c.id} className="comment">
              <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                <span><b>{c.userName}</b> <span className="faint" style={{ fontSize: 12 }}>{ago(c.createdAt)}</span></span>
                <span className="row" style={{ gap: 4 }}>
                  {c.bar !== null && <button className="badge info" onClick={() => onGoto(c.bar!)} title="Go to this bar">Bar {c.bar + 1}</button>}
                  {c.revision !== revision && <span className="badge" title="Written on an earlier revision">rev {c.revision}</span>}
                  {(c.userId === user?.id || user?.role === 'owner') && <button className="iconbtn" aria-label="Delete comment" onClick={() => api.deleteComment(c.id).then(load)}>{Icon.trash({ size: 13 })}</button>}
                </span>
              </div>
              <div className="ctext">{c.text.split(/(@[\p{L}\p{N}._'-]+)/u).map((part, i) => (part.startsWith('@') ? <b key={i} className="mentiontag">{part}</b> : part))}</div>
            </div>
          ))}
        </div>
      )}
      {canWrite && (
        <form style={{ display: 'grid', gap: 6 }} onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          try { await api.addComment(songId, text.trim(), pin ? bar : null); setText(''); load(); } catch (err) { toast((err as Error).message); }
        }}>
          <textarea id="comment-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a comment. @name mentions someone." aria-label="Comment" />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} /> Pin to bar {bar + 1}</label>
            <button className="btn sm primary" disabled={!text.trim()}>Post</button>
          </div>
        </form>
      )}
    </div>
  );
}

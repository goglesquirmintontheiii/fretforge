import type { Instrument, OnlineResult, SongRecord } from '@fretforge/shared';
import { INSTRUMENT_LABELS } from '@fretforge/shared';
import { Icon, InstrumentIcon } from './icons';

const SOURCE_LABEL: Record<string, string> = {
  songsterr: 'Songsterr', 'ultimate-guitar': 'Ultimate Guitar', demo: 'Demo', upload: 'Imported', local: '', created: 'Made here',
};

export function primaryInstrument(list: Instrument[], preferred: Instrument | 'all'): Instrument {
  if (preferred !== 'all' && list.includes(preferred)) return preferred;
  return (['guitar', 'bass', 'drums', 'keys', 'vocals', 'other'] as Instrument[]).find((i) => list.includes(i)) ?? 'other';
}

export function tuningBadges(song: SongRecord, preferred: Instrument | 'all'): string[] {
  const tracks = song.tracks.filter((t) => !t.isPercussion && t.tuningName && (preferred === 'all' || t.instrument === preferred));
  const names = [...new Set(tracks.map((t) => t.tuningName + (t.capo ? ` · capo ${t.capo}` : '')))];
  return names.slice(0, 2);
}

export function SongRow({ song, preferred, onFavorite }: { song: SongRecord; preferred: Instrument | 'all'; onFavorite?: (s: SongRecord) => void }) {
  const src = SOURCE_LABEL[song.source.kind];
  return (
    <a className={'song' + (song.missing ? ' missing' : '')} href={`#/song/${song.id}`}>
      <span className="ico" title={song.instruments.map((i) => INSTRUMENT_LABELS[i]).join(', ')}><InstrumentIcon i={primaryInstrument(song.instruments, preferred)} /></span>
      <span style={{ minWidth: 0 }}>
        <div className="t">{song.title}</div>
        <div className="a">{song.artist || 'Unknown artist'}{song.album ? ` · ${song.album}` : ''}</div>
      </span>
      <span className="meta">
        {song.format === 'text' && <span className="badge">{song.source.variant || 'Text tab'}</span>}
        {tuningBadges(song, preferred).map((t) => <span key={t} className="badge">{t}</span>)}
        {song.format === 'score' && song.tracks.length > 1 && <span className="badge">{song.tracks.length} tracks</span>}
        {song.audioCount ? <span className="badge good" title="Has recordings">♪ {song.audioCount}</span> : null}
        {song.revision ? <span className="badge" title="Edited in Fretforge">rev {song.revision}</span> : null}
        {src && <span className={'badge ' + (song.source.kind === 'songsterr' ? 'info' : song.source.kind === 'ultimate-guitar' ? 'accent' : '')}>{src}</span>}
        {song.missing && <span className="badge bad">File missing</span>}
        {onFavorite && (
          <button className={'star' + (song.favorite ? ' on' : '')} aria-label={song.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={!!song.favorite}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onFavorite(song); }}>
            {song.favorite ? Icon.starFilled({ size: 17 }) : Icon.star({ size: 17 })}
          </button>
        )}
      </span>
    </a>
  );
}

export function OnlineRow({ r, busy, onOpen }: { r: OnlineResult; busy: boolean; onOpen: (r: OnlineResult) => void }) {
  return (
    <button className="song" onClick={() => onOpen(r)} disabled={busy}>
      <span className="ico"><InstrumentIcon i={r.instruments[0] ?? 'guitar'} /></span>
      <span style={{ minWidth: 0 }}>
        <div className="t">{r.title}</div>
        <div className="a">{r.artist}</div>
      </span>
      <span className="meta">
        <span className="badge">{r.variant}</span>
        {r.tuningName && <span className="badge">{r.tuningName}</span>}
        {r.instruments.length > 1 && r.instruments.map((i) => <span key={i} className="badge" title={INSTRUMENT_LABELS[i]}><InstrumentIcon i={i} size={12} /></span>)}
        {r.rating !== undefined && <span className="badge">★ {r.rating}{r.votes ? ` (${r.votes})` : ''}</span>}
        {r.savedId && <span className="badge good">In library</span>}
        {busy && <span className="spinner" aria-label="Opening" />}
      </span>
    </button>
  );
}

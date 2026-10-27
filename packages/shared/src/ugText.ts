import { transposeChord } from './chords';

export type TextSegment = { kind: 'text'; value: string } | { kind: 'chord'; value: string };

export interface TextLine {
  kind: 'lyric' | 'chords' | 'header' | 'tab' | 'blank';
  segments: TextSegment[];
}

const SECTION_RE = /^\s*\[(?!\/?(?:ch|tab)\])([^\]]{1,40})\]\s*$/i;
const TAB_LINE_RE = /^\s*[A-Ga-g][#b]?\s*[|:][-0-9a-z|~/\\^()<>.*x\s]+$/;

/** Split Ultimate Guitar wiki markup into display lines. */
export function parseUgContent(content: string): TextLine[] {
  const text = content.replace(/\r\n?/g, '\n').replace(/\[\/?tab\]/gi, '');
  const lines: TextLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) {
      lines.push({ kind: 'blank', segments: [] });
      continue;
    }
    if (SECTION_RE.test(raw) && !/\[ch\]/i.test(raw)) {
      lines.push({ kind: 'header', segments: [{ kind: 'text', value: raw.trim().replace(/^\[|\]$/g, '') }] });
      continue;
    }
    const segments: TextSegment[] = [];
    const re = /\[ch\](.*?)\[\/ch\]/gi;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      if (m.index > last) segments.push({ kind: 'text', value: raw.slice(last, m.index) });
      segments.push({ kind: 'chord', value: m[1] });
      last = m.index + m[0].length;
    }
    if (last < raw.length) segments.push({ kind: 'text', value: raw.slice(last) });
    const hasChord = segments.some((s) => s.kind === 'chord');
    const nonChordText = segments.filter((s) => s.kind === 'text').map((s) => s.value).join('');
    let kind: TextLine['kind'] = 'lyric';
    if (hasChord && !nonChordText.trim().replace(/[|x\d()\-/.]/g, '')) kind = 'chords';
    else if (TAB_LINE_RE.test(raw)) kind = 'tab';
    lines.push({ kind, segments });
  }
  return lines;
}

/**
 * Transpose chord segments in a line while keeping column alignment:
 * a longer chord eats following spaces, a shorter one is padded.
 */
export function transposeLine(line: TextLine, semitones: number, preferFlats?: boolean): TextLine {
  if (!semitones) return line;
  const out: TextSegment[] = [];
  let debt = 0;
  for (const seg of line.segments) {
    if (seg.kind === 'chord') {
      const t = transposeChord(seg.value, semitones, preferFlats);
      debt += t.length - seg.value.length;
      out.push({ kind: 'chord', value: t });
    } else {
      let v = seg.value;
      if (debt > 0) {
        const m = /^ +/.exec(v);
        const eat = Math.min(debt, m ? Math.max(0, m[0].length - 1) : 0);
        v = v.slice(eat);
        debt -= eat;
      } else if (debt < 0) {
        v = ' '.repeat(-debt) + v;
        debt = 0;
      }
      out.push({ kind: 'text', value: v });
    }
  }
  return { kind: line.kind, segments: out };
}

/** Unique chord names in order of first appearance. */
export function chordsInContent(lines: TextLine[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) for (const s of l.segments) if (s.kind === 'chord' && !seen.has(s.value)) { seen.add(s.value); out.push(s.value); }
  return out;
}

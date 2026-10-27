// Song export: Guitar Pro 7, MIDI, alphaTex and printing (PDF through the print dialog).
import * as alphaTab from '@coderline/alphatab';

function download(bytes: Uint8Array | string, name: string, type: string) {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'song';
}

export function exportGp(score: alphaTab.model.Score, settings: alphaTab.Settings, name: string) {
  download(new alphaTab.exporter.Gp7Exporter().export(score, settings), `${safeName(name)}.gp`, 'application/octet-stream');
}

export function exportMidi(score: alphaTab.model.Score, settings: alphaTab.Settings, name: string) {
  const midi = new alphaTab.midi.MidiFile();
  const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(midi, true);
  const gen = new alphaTab.midi.MidiFileGenerator(score, settings, handler);
  gen.generate();
  download(midi.toBinary(), `${safeName(name)}.mid`, 'audio/midi');
}

export function exportAlphaTex(score: alphaTab.model.Score, settings: alphaTab.Settings, name: string) {
  const tex = new alphaTab.exporter.AlphaTexExporter().exportToString(score, settings);
  download(tex, `${safeName(name)}.alphatex`, 'text/plain');
}

/**
 * Prints the score (use "Save as PDF" in the print dialog). The tab is rendered once more in
 * page layout at print width, in light colours, into a print-only container.
 */
export async function printScore(score: alphaTab.model.Score, tracks: number[], title: string): Promise<void> {
  const host = document.createElement('div');
  host.className = 'print-host';
  document.body.appendChild(host);
  const inner = document.createElement('div');
  host.appendChild(inner);
  const api = new alphaTab.AlphaTabApi(inner, {
    core: { fontDirectory: '/font/', useWorkers: false, logLevel: alphaTab.LogLevel.None },
    display: { layoutMode: alphaTab.LayoutMode.Page, scale: 0.9, width: 1000 },
    player: { playerMode: alphaTab.PlayerMode.Disabled },
  } as never);
  try {
    await new Promise<void>((resolve) => {
      api.postRenderFinished.on(() => resolve());
      api.renderScore(score, tracks);
      setTimeout(resolve, 15000);
    });
    const before = document.title;
    document.title = title;
    document.body.classList.add('printing');
    window.print();
    document.title = before;
  } finally {
    document.body.classList.remove('printing');
    api.destroy();
    host.remove();
  }
}

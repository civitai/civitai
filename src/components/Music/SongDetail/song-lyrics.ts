import type { LyricLine } from '~/server/schema/media.schema';

export type LyricRow =
  | { kind: 'section'; label: string }
  | { kind: 'line'; index: number; t: number | null; text: string };

const SECTION = /^\s*\[(.+)\]\s*$/;

/** The lines as the detail view shows them: `[Verse 1]` style lines become section labels. */
export function toLyricRows(lines: LyricLine[]): LyricRow[] {
  return lines.map((line, index) => {
    const section = SECTION.exec(line.text);
    return section
      ? { kind: 'section', label: section[1].trim() }
      : { kind: 'line', index, t: line.t, text: line.text };
  });
}

const isSung = (line: LyricLine) => !SECTION.test(line.text);

/** True when any sung line has a time: only then do lines highlight and seek. */
export function isSyncedLyrics(lines: LyricLine[]) {
  return lines.some((line) => line.t != null && isSung(line));
}

/** The index of the last timed, sung line at or before `timeMs`, or -1. */
export function currentLyricIndex(lines: LyricLine[], timeMs: number) {
  let current = -1;
  lines.forEach((line, index) => {
    if (line.t != null && line.t <= timeMs && isSung(line)) current = index;
  });
  return current;
}

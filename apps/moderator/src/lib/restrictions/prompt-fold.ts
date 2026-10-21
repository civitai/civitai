export type Fold = { folded: boolean; head: string; total: number };

/** How far back from the cut to look for a comma or space to end on. */
const BOUNDARY_WINDOW = 200;

/** Long prompts show only their start; a prompt at or under the threshold is shown whole. */
export function foldPrompt(text: string, { threshold, head }: { threshold: number; head: number }): Fold {
  const total = text.length;
  if (total <= threshold) return { folded: false, head: text, total };

  const floor = Math.max(0, head - BOUNDARY_WINDOW);
  const window = text.slice(floor, head);
  const comma = window.lastIndexOf(',');
  const space = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'));
  const at = comma !== -1 ? floor + comma : space !== -1 ? floor + space : head;
  return { folded: true, head: text.slice(0, at).trimEnd(), total };
}

/** The first `length` characters of a segment list, so highlighting survives the cut. */
export function cutSegments<T extends { text: string }>(segments: T[], length: number): T[] {
  const out: T[] = [];
  let used = 0;
  for (const s of segments) {
    if (used >= length) break;
    const room = length - used;
    out.push(s.text.length > room ? { ...s, text: s.text.slice(0, room) } : s);
    used += s.text.length;
  }
  return out;
}

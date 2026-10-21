export type Fold = { folded: boolean; head: string; total: number };

/** How far back from the cut to look for a comma or space to end on. */
const BOUNDARY_WINDOW = 200;
/** Text kept after the last match, so the match reads in context. */
const MATCH_CONTEXT = 200;
/** Folding away less than this saves nothing worth an extra click. */
const MIN_HIDDEN = 500;

/**
 * Long prompts show only their start; a prompt at or under the threshold is shown whole.
 * `keepThrough` is where the last highlighted match ends: the fold never hides evidence.
 */
export function foldPrompt(
  text: string,
  { threshold, head, keepThrough = 0 }: { threshold: number; head: number; keepThrough?: number }
): Fold {
  const total = text.length;
  const target = Math.max(head, keepThrough > 0 ? keepThrough + MATCH_CONTEXT : 0);
  if (total <= threshold || total - target < MIN_HIDDEN)
    return { folded: false, head: text, total };

  const floor = Math.max(keepThrough, target - BOUNDARY_WINDOW);
  const window = text.slice(floor, target);
  const comma = window.lastIndexOf(',');
  const space = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'));
  const at = comma !== -1 ? floor + comma : space !== -1 ? floor + space : target;
  return { folded: true, head: text.slice(0, at).trimEnd(), total };
}

/** Where the last occurrence of any highlight needle ends, matched case-insensitively; 0 for none. */
export function lastMatchEnd(text: string, needles: string[]): number {
  const haystack = text.toLowerCase();
  let end = 0;
  for (const raw of needles) {
    const needle = raw.trim().toLowerCase();
    if (!needle) continue;
    const at = haystack.lastIndexOf(needle);
    if (at !== -1) end = Math.max(end, at + needle.length);
  }
  return end;
}

/** Where the last categorised (highlighted) segment ends; 0 for none. */
export function lastSegmentEnd(segments: { text: string; category: string | null }[]): number {
  let used = 0;
  let end = 0;
  for (const s of segments) {
    used += s.text.length;
    if (s.category) end = used;
  }
  return end;
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

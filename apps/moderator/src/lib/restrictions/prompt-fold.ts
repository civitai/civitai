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
 * `null` means evidence exists that cannot be located in the text, so nothing may be folded.
 */
export function foldPrompt(
  text: string,
  { threshold, head, keepThrough = 0 }: { threshold: number; head: number; keepThrough?: number | null }
): Fold {
  const total = text.length;
  if (keepThrough === null) return { folded: false, head: text, total };
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

export type FoldBox = 'prompt' | 'negativePrompt' | 'text';
export type FoldEvidence = {
  text?: string;
  regex?: string;
  gateWord?: string;
  field?: 'prompt' | 'negativePrompt';
};

/**
 * How far a box must stay visible to keep its recorded evidence in view, or null when some of that
 * evidence cannot be located in `shown` (a regex-only match, or a literal that is not in the text).
 * Scanned text has no field, so every match applies to it; a gate word never applies to the negative.
 */
export function keepThroughFor(
  shown: string,
  box: FoldBox,
  matches: FoldEvidence[]
): number | null {
  const haystack = shown.toLowerCase();
  let end = 0;
  let applicable = false;
  let located = false;
  for (const m of matches) {
    const forBox = box === 'text' || !m.field || m.field === box;
    const explicit = box !== 'text' && m.field === box;
    const literals: { needle: string; explicit: boolean }[] = [];
    if (m.text?.trim() && forBox) literals.push({ needle: m.text, explicit });
    if (m.gateWord?.trim() && box !== 'negativePrompt') literals.push({ needle: m.gateWord, explicit: false });

    if (!literals.length && m.regex && forBox) return null;
    for (const l of literals) {
      applicable = true;
      const at = haystack.lastIndexOf(l.needle.trim().toLowerCase());
      if (at === -1) {
        if (l.explicit) return null;
        continue;
      }
      located = true;
      end = Math.max(end, at + l.needle.trim().length);
    }
  }
  return applicable && !located ? null : end;
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

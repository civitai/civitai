export type Span = { start: number; end: number };
export type FieldSegment = { text: string; hit: boolean };

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Pulls an edge off the middle of a surrogate pair, so a stored offset never leaves half an emoji. */
function snapStart(text: string, at: number) {
  return at > 0 && isLowSurrogate(text.charCodeAt(at)) && isHighSurrogate(text.charCodeAt(at - 1))
    ? at - 1
    : at;
}
function snapEnd(text: string, at: number) {
  return at > 0 &&
    at < text.length &&
    isHighSurrogate(text.charCodeAt(at - 1)) &&
    isLowSurrogate(text.charCodeAt(at))
    ? at + 1
    : at;
}

/**
 * Splits a field into plain and highlighted runs from the offsets the matcher stored (`fields[i].text.slice(start, end)`).
 * Offsets are used as written, never re-searched, so a term that also occurs elsewhere is not highlighted there.
 */
export function fieldSegments(text: string, spans: readonly Span[]): FieldSegment[] {
  const clamped = spans
    .map(({ start, end }) => ({
      start: snapStart(text, Math.max(0, Math.min(start, text.length))),
      end: snapEnd(text, Math.max(0, Math.min(end, text.length))),
    }))
    .filter(({ start, end }) => end > start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Span[] = [];
  for (const span of clamped) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  const out: FieldSegment[] = [];
  let at = 0;
  for (const { start, end } of merged) {
    if (start > at) out.push({ text: text.slice(at, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length || !out.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** The spans of one scanned field, picked by the match's `fieldIndex`. */
export const spansForField = (
  matches: readonly { fieldIndex: number; start: number; end: number }[],
  fieldIndex: number
): Span[] =>
  matches
    .filter((match) => match.fieldIndex === fieldIndex)
    .map(({ start, end }) => ({ start, end }));

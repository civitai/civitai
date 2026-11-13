import type { TextScanSubject } from '~/server/services/text-scan/types';

/** Text before a cut that the continuation scans again, so a sentence across the cut is seen whole. */
export const SEGMENT_OVERLAP_CHARS = 2_000;
/** Floor on the budget, so a field heading plus useful text always fits one segment. */
export const MIN_SEGMENT_CHARS = 1_000;

const FIELD_SEPARATOR = '\n\n';
const WHITESPACE = /\s/;

type FieldBlock = { prefix: string; body: string; start: number };

function fieldBlocks(subject: TextScanSubject): FieldBlock[] {
  const blocks: FieldBlock[] = [];
  let offset = 0;
  for (const field of subject.fields) {
    const body = field.text?.trim();
    if (!body) continue;
    if (blocks.length) offset += FIELD_SEPARATOR.length;
    const prefix = `## ${field.heading}\n`;
    blocks.push({ prefix, body, start: offset });
    offset += prefix.length + body.length;
  }
  return blocks;
}

/** The whole composed text. The dedup and appeal hashes depend on it never changing for the same fields. */
export function composeUserText(subject: TextScanSubject) {
  return fieldBlocks(subject)
    .map((block) => block.prefix + block.body)
    .join(FIELD_SEPARATOR);
}

export type SegmentedText = {
  text: string;
  segments: string[];
  inputChars: number;
  /** Offset in `text` where scanning stopped; below `inputChars` only when `maxSegments` ran out. */
  scannedChars: number;
  inputCut: boolean;
};

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const splitsSurrogatePair = (text: string, index: number) =>
  index > 0 &&
  index < text.length &&
  isHighSurrogate(text.charCodeAt(index - 1)) &&
  isLowSurrogate(text.charCodeAt(index));

/** Prefers the last paragraph, line or word break in the back half of the room. */
function chooseCut(body: string, start: number, end: number, room: number) {
  const floor = start + Math.floor(room / 2);
  const paragraph = body.lastIndexOf('\n\n', end - 2);
  if (paragraph >= floor) return paragraph + 2;
  const line = body.lastIndexOf('\n', end - 1);
  if (line >= floor) return line + 1;
  for (let i = end - 1; i >= floor; i--) if (WHITESPACE.test(body[i])) return i + 1;
  return splitsSurrogatePair(body, end) ? end - 1 : end;
}

/** A heading too long to repeat would leave each piece of its field almost no room, or none. */
function repeatablePrefix(prefix: string, limit: number) {
  const cap = Math.floor(limit / 4);
  if (prefix.length <= cap) return prefix;
  const end = splitsSurrogatePair(prefix, cap - 1) ? cap - 2 : cap - 1;
  return `${prefix.slice(0, end)}\n`;
}

function continuationStart(body: string, cut: number, overlap: number) {
  let start = cut - overlap;
  const space = body.slice(start, cut).search(WHITESPACE);
  if (space !== -1) {
    start += space;
    while (start < cut && WHITESPACE.test(body[start])) start++;
  }
  if (splitsSurrogatePair(body, start)) start++;
  return start;
}

/**
 * Text within the budget comes back whole as its only segment, byte-identical to `composeUserText`.
 * Longer text is split between fields first; a field longer than the budget is split at a paragraph,
 * line or word break, and each continuation repeats the field's heading and re-reads the end of
 * the previous piece.
 */
export function segmentUserText(
  subject: TextScanSubject,
  { budget, maxSegments }: { budget: number; maxSegments: number }
): SegmentedText {
  const text = composeUserText(subject);
  const limit = Math.max(budget, MIN_SEGMENT_CHARS);
  if (text.length <= limit)
    return {
      text,
      segments: [text],
      inputChars: text.length,
      scannedChars: text.length,
      inputCut: false,
    };

  const overlap = Math.min(SEGMENT_OVERLAP_CHARS, Math.floor(limit / 10));
  const segments: string[] = [];
  let current = '';
  let scannedChars = 0;

  const roomAfter = (prefix: string) =>
    limit - current.length - (current ? FIELD_SEPARATOR.length : 0) - prefix.length;
  const append = (piece: string, endOffset: number) => {
    current = current ? current + FIELD_SEPARATOR + piece : piece;
    scannedChars = endOffset;
  };
  // Only called when more text remains, so hitting maxSegments here means text is cut.
  const closeOrStop = () => {
    if (current) segments.push(current);
    current = '';
    return segments.length >= maxSegments;
  };

  scan: for (const block of fieldBlocks(subject)) {
    const whole = block.prefix + block.body;
    if (roomAfter('') >= whole.length) {
      append(whole, block.start + whole.length);
      continue;
    }
    if (whole.length <= limit) {
      if (closeOrStop()) break;
      append(whole, block.start + whole.length);
      continue;
    }
    const prefix = repeatablePrefix(block.prefix, limit);
    if (current && roomAfter(prefix) < limit / 4 && closeOrStop()) break;
    let start = 0;
    for (;;) {
      const room = roomAfter(prefix);
      const end = Math.min(block.body.length, start + room);
      const cut = end === block.body.length ? end : chooseCut(block.body, start, end, room);
      append(prefix + block.body.slice(start, cut), block.start + block.prefix.length + cut);
      if (cut === block.body.length) break;
      if (closeOrStop()) break scan;
      start = continuationStart(block.body, cut, overlap);
    }
  }
  if (current) segments.push(current);
  return {
    text,
    segments,
    inputChars: text.length,
    scannedChars,
    inputCut: scannedChars < text.length,
  };
}

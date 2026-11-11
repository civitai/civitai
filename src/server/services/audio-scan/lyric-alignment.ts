/** One word of a transcription, with its offsets in seconds. */
export type TranscribedWord = { text: string; startTime: number; endTime: number };
export type LyricLine = { t: number | null; text: string };

// A transcriber is wrong about a few words and the singer drops or adds some, so a line counts as
// found when most of it lines up, not all of it.
const MIN_LINE_SCORE = 0.6;
// A line of one or two words has too little to compare to forgive any miss.
const SHORT_LINE_TOKENS = 2;
// How far past the previous line a line may start. Bounds the cost and stops a lost line from
// being matched to a verse sung minutes later.
const LOOKAHEAD_TOKENS = 40;
// Extra transcript words read past a line's length, for words the transcriber added.
const WINDOW_SLACK = 2;
const PAUSE_BREAK_SECONDS = 1;
const MAX_WORDS_PER_BUILT_LINE = 12;

const SECTION_TAG = /^\s*[[({][^\])}]*[\])}]\s*$/;

function tokenize(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function editDistance(a: string, b: string) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/**
 * Equal, or a near miss of a word long enough that one wrong letter is still that word. Memoized per
 * pair: a long song asks about the same few thousand pairs many times over.
 */
function wordMatcher() {
  const seen = new Map<string, boolean>();
  return (a: string, b: string) => {
    if (a === b) return true;
    const shortest = Math.min(a.length, b.length);
    const longest = Math.max(a.length, b.length);
    const allowed = Math.floor(longest / 4);
    // Too short, too different in length, or a different first letter: no edit distance needed.
    if (shortest < 4 || longest - shortest > allowed || a[0] !== b[0]) return false;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    let same = seen.get(key);
    if (same === undefined) {
      same = editDistance(a, b) <= allowed;
      seen.set(key, same);
    }
    return same;
  };
}

type Token = { token: string; start: number };
type Cell = { len: number; first: number; last: number };
/** One DP row, reused for every window. */
type Scratch = { len: Int32Array; first: Int32Array; last: Int32Array };

/** The best ordered, fuzzy overlap of a line with the start of a transcript window. */
function overlap(
  line: string[],
  window: Token[],
  same: (a: string, b: string) => boolean,
  { len, first, last }: Scratch
): Cell {
  const n = window.length;
  len.fill(0, 0, n + 1);
  first.fill(-1, 0, n + 1);
  last.fill(-1, 0, n + 1);
  for (let i = 1; i <= line.length; i++) {
    // The previous row's value to the left, which the in-place update has already overwritten.
    let dLen = 0;
    let dFirst = -1;
    let dLast = -1;
    for (let j = 1; j <= n; j++) {
      const uLen = len[j];
      const uFirst = first[j];
      const uLast = last[j];
      let bLen = uLen;
      let bFirst = uFirst;
      let bLast = uLast;
      if (len[j - 1] > bLen || (len[j - 1] === bLen && first[j - 1] < bFirst)) {
        bLen = len[j - 1];
        bFirst = first[j - 1];
        bLast = last[j - 1];
      }
      if (same(line[i - 1], window[j - 1].token)) {
        const cLen = dLen + 1;
        const cFirst = dLen === 0 ? j - 1 : dFirst;
        if (cLen > bLen || (cLen === bLen && cFirst <= bFirst)) {
          bLen = cLen;
          bFirst = cFirst;
          bLast = j - 1;
        }
      }
      dLen = uLen;
      dFirst = uFirst;
      dLast = uLast;
      len[j] = bLen;
      first[j] = bFirst;
      last[j] = bLast;
    }
  }
  return { len: len[n], first: first[n], last: last[n] };
}

function alignToStored(lyrics: LyricLine[], words: TranscribedWord[]): LyricLine[] {
  const transcript: Token[] = words.flatMap((word) =>
    tokenize(word.text).map((token) => ({ token, start: word.startTime }))
  );
  const lines = lyrics.map(({ text }) => tokenize(text));
  const size = Math.max(0, ...lines.map((l) => l.length)) + WINDOW_SLACK + 1;
  const scratch: Scratch = {
    len: new Int32Array(size),
    first: new Int32Array(size),
    last: new Int32Array(size),
  };
  const same = wordMatcher();
  let cursor = 0;

  return lyrics.map(({ text }, index) => {
    const unplaced = { t: null, text };
    const line = lines[index];
    if (!line.length || SECTION_TAG.test(text)) return unplaced;

    let best: { score: number; at: number; cell: Cell } | undefined;
    const lastStart = Math.min(cursor + LOOKAHEAD_TOKENS, transcript.length - 1);
    for (let p = cursor; p <= lastStart; p++) {
      const cell = overlap(
        line,
        transcript.slice(p, p + line.length + WINDOW_SLACK),
        same,
        scratch
      );
      const score = cell.len / line.length;
      if (cell.len && (!best || score > best.score)) best = { score, at: p, cell };
    }

    if (!best) return unplaced;
    const enough =
      line.length <= SHORT_LINE_TOKENS ? best.score === 1 : best.score >= MIN_LINE_SCORE;
    if (!enough) return unplaced;

    cursor = best.at + best.cell.last + 1;
    return { t: transcript[best.at + best.cell.first].start, text };
  });
}

function buildFromWords(words: TranscribedWord[]): LyricLine[] {
  const built: { t: number; words: string[] }[] = [];
  let previous: TranscribedWord | undefined;
  for (const word of words) {
    const text = word.text.trim();
    if (!text) continue;
    const current = built[built.length - 1];
    const startsLine =
      !current ||
      current.words.length >= MAX_WORDS_PER_BUILT_LINE ||
      /[.!?]$/.test(current.words[current.words.length - 1]) ||
      (!!previous && word.startTime - previous.endTime >= PAUSE_BREAK_SECONDS);
    if (startsLine) built.push({ t: word.startTime, words: [text] });
    else current.words.push(text);
    previous = word;
  }
  return built.map(({ t, words: lineWords }) => ({ t, text: lineWords.join(' ') }));
}

/**
 * Lyric lines with offsets in seconds. Stored lyrics keep their own text and gain the start of the
 * first transcribed word they match, in order; a line that cannot be placed stays `t: null`. With no
 * stored lyrics the lines are built from the transcription itself.
 */
export function alignLyrics({
  lyrics,
  words,
}: {
  lyrics: LyricLine[] | undefined;
  words: TranscribedWord[];
}): LyricLine[] {
  if (!lyrics?.length) return buildFromWords(words);
  return alignToStored(lyrics, words);
}

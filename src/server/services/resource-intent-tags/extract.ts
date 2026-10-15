/**
 * The v1 content-tag extractor: prompt → canonical phrase keys, and the literal match of those keys
 * against a frozen vocabulary. A port of the offline prototype that mined the vocabulary and ran the
 * screen; the vocabulary's keys only mean what was measured if prompts are cut by these exact rules.
 * `src/server/services/__tests__/resource-intent-tags.extract.parity.test.ts` holds it to the
 * prototype's own output on a golden fixture.
 *
 * Imports nothing, so a study script can load it.
 *
 * Python's `re` and `str` are Unicode-aware where JavaScript's defaults are not, so each class below
 * spells out Python's definition rather than using `\w`, `\s`, `\d` or `\b`:
 * - `\w` is letters, numbers and `_` — but not combining marks;
 * - `\s` and `str.split()` include U+001C–U+001F and U+0085, and exclude U+FEFF;
 * - `str.isdigit()` also accepts the digit-valued `No` characters NFKC leaves alone;
 * - `len()` counts code points, not UTF-16 units.
 * `\p{L}`/`\p{N}` follow the runtime's Unicode version and Python follows its own; re-check parity
 * after a Node or ICU upgrade.
 */

const WORD = String.raw`\p{L}\p{N}_`;
const SPACE = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}`;
const DIGIT_NO = String.raw`\u{1369}-\u{1371}\u{19da}\u{24f5}-\u{24fd}\u{24ff}\u{2776}-\u{277e}\u{2780}-\u{2788}\u{278a}-\u{2792}\u{10a40}-\u{10a43}\u{10e60}-\u{10e68}\u{11052}-\u{1105a}`;

const EMBED = new RegExp(String.raw`(?<![${WORD}])embedding:[^${SPACE}]+`, 'gu');
/** `(word:1.2)` weights. */
const WEIGHT = new RegExp(String.raw`:[${SPACE}]*-?\p{Nd}+(?:\.\p{Nd}+)?`, 'gu');
const BRACKET = /[()[\]{}]/gu;
const SPLIT = new RegExp(String.raw`[,\n\r;|.!?]+|(?<![${WORD}])break(?![${WORD}])`, 'u');
const NONWORD = new RegExp(String.raw`[^${WORD}${SPACE}'-]`, 'gu');
const WHITESPACE = new RegExp(String.raw`[${SPACE}]+`, 'u');
const ALL_DIGITS = new RegExp(String.raw`^[\p{Nd}${DIGIT_NO}]+$`, 'u');

export const TAG_MAX_SEGMENT_TOKENS = 4;
export const TAG_GRAM_SIZES = [1, 2, 3] as const;

// prettier-ignore
export const TAG_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'across', 'after', 'against', 'all', 'almost', 'also', 'an', 'and', 'another',
  'any', 'are', 'around', 'as', 'at', 'be', 'because', 'been', 'before', 'behind', 'being',
  'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'done', 'down',
  'during', 'each', 'even', 'every', 'for', 'from', 'fully', 'gently', 'get', 'gets', 'got', 'had',
  'has', 'have', 'having', 'he', 'her', 'here', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'just', 'like', 'made', 'make', 'makes', 'may', 'me', 'might', 'more', 'most',
  'mostly', 'must', 'my', 'no', 'not', 'of', 'off', 'on', 'only', 'onto', 'or', 'other', 'our',
  'out', 'over', 'partially', 'quite', 'rather', 'really', 'shall', 'she', 'should', 'slightly',
  'slowly', 'so', 'softly', 'some', 'still', 'such', 'than', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'toward', 'towards', 'under',
  'up', 'upon', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
  'whom', 'whose', 'why', 'will', 'with', 'within', 'without', 'would', 'you', 'your',
]);

const codePointLength = (s: string) => [...s].length;

/** Python's `str.strip("'-")`. A regex `['-]+$` here is quadratic in a long run of `'`/`-`. */
function stripQuotesAndHyphens(t: string): string {
  let i = 0;
  let j = t.length;
  while (i < j && (t[i] === "'" || t[i] === '-')) i++;
  while (j > i && (t[j - 1] === "'" || t[j - 1] === '-')) j--;
  return t.slice(i, j);
}

/**
 * `<...>` tags (`<lora:...>`) each replaced by `,`: exactly `s.replace(/<[^>]*>/gu, ',')`, as a linear
 * scan. That regex retries from every `<` to the end of the string when no `>` follows, which is
 * quadratic in a run of `<`. Each `<` is paired with the first `>` after it, the scan resumes after
 * that `>`, and once a `<` has no `>` after it no later `<` can have one either.
 */
export function replaceAngleTags(s: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const i = s.indexOf('<', pos);
    if (i < 0) break;
    const j = s.indexOf('>', i + 1);
    if (j < 0) break;
    out += s.slice(pos, i) + ',';
    pos = j + 1;
  }
  return out + s.slice(pos);
}

/**
 * Singular form of one token: `-ies` → `-y` above 4 code points; else a trailing `s` dropped above
 * 3, except after `s`, `u` or `i`.
 */
export function singularizeTagToken(t: string): string {
  if (t.endsWith('ies') && codePointLength(t) > 4) return t.slice(0, -3) + 'y';
  if (
    t.endsWith('s') &&
    !t.endsWith('ss') &&
    !t.endsWith('us') &&
    !t.endsWith('is') &&
    codePointLength(t) > 3
  )
    return t.slice(0, -1);
  return t;
}

/** Canonical key of a phrase: hyphens dropped, then each token singularised, space-joined. */
export function canonicalTagKey(tokens: readonly string[]): string {
  return tokens
    .map((t) => t.replaceAll('-', ''))
    .filter(Boolean)
    .map(singularizeTagToken)
    .join(' ');
}

/** A prompt's segments, each as its tokens: syntax stripped, split at separators and `BREAK`. */
export function tagSegments(prompt: string): string[][] {
  const p = replaceAngleTags(prompt.normalize('NFKC').toLowerCase())
    .replace(EMBED, ',')
    .replaceAll('\\(', '(')
    .replaceAll('\\)', ')')
    .replace(WEIGHT, '')
    .replace(BRACKET, ',')
    .replaceAll('_', ' ');
  const out: string[][] = [];
  for (const piece of p.split(SPLIT)) {
    const toks = piece
      .replace(NONWORD, ' ')
      .split(WHITESPACE)
      .map(stripQuotesAndHyphens)
      .filter((t) => t && !ALL_DIGITS.test(t));
    if (toks.length) out.push(toks);
  }
  return out;
}

/**
 * A prompt's keys, in two kinds. A segment key is a whole segment of at most
 * `TAG_MAX_SEGMENT_TOKENS` tokens, unless every token is a stopword: the writer used it as a tag. A
 * gram key is a stopword-free 1–3-gram of a longer, sentence-like segment. Vocabulary admission
 * counts segment keys only; tagging uses both.
 */
export function tagKeySets(prompt: string): { segment: Set<string>; gram: Set<string> } {
  const segment = new Set<string>();
  const gram = new Set<string>();
  for (const toks of tagSegments(prompt)) {
    if (toks.length <= TAG_MAX_SEGMENT_TOKENS) {
      if (!toks.every((t) => TAG_STOPWORDS.has(t))) {
        const k = canonicalTagKey(toks);
        if (k) segment.add(k);
      }
      continue;
    }
    for (const n of TAG_GRAM_SIZES) {
      for (let i = 0; i + n <= toks.length; i++) {
        const g = toks.slice(i, i + n);
        if (g.some((t) => TAG_STOPWORDS.has(t))) continue;
        const k = canonicalTagKey(g);
        if (k) gram.add(k);
      }
    }
  }
  return { segment, gram };
}

export function tagKeys(prompt: string): Set<string> {
  const { segment, gram } = tagKeySets(prompt);
  return new Set([...segment, ...gram]);
}

/** Code-point order (Python's `sorted`), not `Array.prototype.sort`'s UTF-16 order. */
export function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const d = (x.value.codePointAt(0) as number) - (y.value.codePointAt(0) as number);
    if (d) return d;
  }
}

/** The vocabulary keys written literally in `prompt`, in code-point order. */
export function matchVocabularyKeys(prompt: string, vocabulary: ReadonlySet<string>): string[] {
  return [...tagKeys(prompt)].filter((k) => vocabulary.has(k)).sort(compareCodePoints);
}

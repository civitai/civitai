import youngWords from './words-young.json';

/**
 * The gap between a young-adjective and a partial noun, e.g. `young` … `girl`.
 *
 * 🔴 Every quantifier must stay BOUNDED. The partial nouns end in `\w*`, so an unbounded
 * gap (the original `([\s|\w]*|[^\w]+)`) sits adjacent to it over the same input run →
 * O(n²) backtracking on a long Latin `\w` run, a user-triggerable main-thread DoS. Any
 * finite bound is linear, so the WIDTH is a recall decision alone, never a perf one.
 *
 * The word-run branch deliberately cannot cross a blank line: an adjective and a noun in
 * separate paragraphs describe separate subjects.
 */
export const composedNounGap =
  '((?:[\\w|]|[^\\S\\n]|\\n(?![^\\S\\n]{0,200}\\n)){0,200}|[^\\w]{1,200})';

// Width and paragraph semantics are pinned by
// src/utils/metadata/__tests__/audit-composed-noun-gap.test.ts.
export const youngComposedNouns = youngWords.partialNouns.flatMap((word) =>
  youngWords.adjectives.map((adj) => adj + composedNounGap + word)
);

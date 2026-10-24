import youngWords from './words-young.json';

/**
 * The gap between a young-adjective and a partial noun, e.g. `young` … `girl`.
 *
 * 🔴 Every quantifier must stay BOUNDED. The partial nouns end in `\w*`, so an unbounded
 * gap (the original `([\s|\w]*|[^\w]+)`) sits adjacent to it over the same input run →
 * O(n²) backtracking on a long Latin `\w` run, a user-triggerable main-thread DoS. Any
 * finite bound is linear, so the WIDTH is a recall decision alone, never a perf one.
 *
 * 🔴 It crosses blank lines ON PURPOSE, pending the multi-signal scorer. A paragraph-aware
 * variant — an adjective and a noun in separate paragraphs describing separate subjects —
 * was written and held: on its own it is a pure recall LOSS on the minor-detection path,
 * and the case for taking that loss depends on the score absorbing the signal instead.
 * Do not re-land it as a standalone tidy-up.
 */
export const composedNounGap = '([\\s|\\w]{0,200}|[^\\w]{1,200})';

/**
 * The noun must start a word, or follow the adjective directly (`littlegirl`). Without
 * that, the gap's `\w` branch ends mid-word and `small curved crimson` reads as
 * `small … son`. Compounds the boundary would lose are spelled out in the list
 * (`(?:step|grand|god|half)?son`). In the `boy` entry, `(?!cowbo)` keeps `cowboy shot` and
 * `(?![-_]?shorts)` keeps `boyshorts` from reading as `boy`; `boy shorts` with a space still
 * flags, since it cannot be told from `young boy, shorts`.
 */
const gapToNounStart = `(?:${composedNounGap}(?<![a-zA-Z0-9])|)`;

// The width is pinned by
// src/utils/metadata/__tests__/audit-composed-noun-gap.test.ts.
export const youngComposedNouns = youngWords.partialNouns.flatMap((word) =>
  youngWords.adjectives.map((adj) => adj + gapToNounStart + word)
);

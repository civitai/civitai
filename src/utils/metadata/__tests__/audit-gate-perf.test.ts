import { describe, it, expect } from 'vitest';
import { checkable } from '~/utils/metadata/audit';
import poiWords from '~/utils/metadata/lists/words-poi.json';
import nsfwPromptWords from '~/utils/metadata/lists/words-nsfw-prompt.json';
import nsfwWordsPaddle from '~/utils/metadata/lists/words-paddle-nsfw.json';
import youngWords from '~/utils/metadata/lists/words-young.json';
import { ABSOLUTE_HANG_CEILING_MS, expectSubQuadraticScaling } from './redos-perf-helpers';

/**
 * Combined-regex "gate" pre-filter — ZERO-WIDTH boundary ReDoS guard.
 *
 * PR #2452 added a per-chunk combined-regex gate to `checkable()` so a no-match
 * prompt skips the full per-word loop (~300x on the dominant no-match scan). It was
 * reverted in #2719 because #2452 built the gate with CONSUMING greedy boundaries
 *   ([^a-zA-Z0-9]+|^)(?:body1|…|bodyN)([^a-zA-Z0-9]+|$)
 * which backtracked O(n²) on a long non-Latin (CJK) prompt — one giant
 * `[^a-zA-Z0-9]` run — exactly the ReDoS class #2722 then fixed on the per-word
 * regexes by switching to ZERO-WIDTH boundaries.
 *
 * The gate has now been RESTORED but rebuilt with the #2722 zero-width boundaries:
 *   (?<![a-zA-Z0-9])(?:body1|…|bodyN)(?![a-zA-Z0-9])
 * Being zero-width, the boundary assertions have nothing to backtrack over the long
 * run → the gate is linear and CANNOT reintroduce the CJK backtrack.
 *
 * This file is the perf guard for the RESTORED gate: it feeds a long pathological
 * CJK no-match prompt through the gated `inPrompt`/`highlight` of a `checkable` built
 * from large, quantifier-heavy word lists (POI + the composed young-noun bodies,
 * whose `([\s|\w]*|[^\w]+)` interiors were the worst case the old gate amplified
 * across a 200-way alternation) and asserts each call finishes well under budget. On
 * the OLD consuming-boundary gate this shape took seconds; here it must be linear.
 *
 * Matching CORRECTNESS of the gate (results byte-identical to the gateless per-word
 * loop) is proven separately by audit-matching-equivalence.test.ts.
 */

// A long run of non-Latin (CJK) characters with embedded ASCII tokens — the exact
// shape that pinned the prod event loop. None of the embedded tokens match any list
// entry, so the gate MUST miss and short-circuit (the no-match fast path).
function buildCjkNoMatchPrompt(cjkCharsEachSide: number): string {
  const a = '美'.repeat(cjkCharsEachSide);
  const b = '丽'.repeat(cjkCharsEachSide);
  const c = '風'.repeat(cjkCharsEachSide);
  return `${a} a serene landscape ${b} cinematic lighting ${c} masterpiece`;
}

// The young-noun list audit.ts uses, including the composed adj·([\s|\w]*|[^\w]+)·noun
// bodies (unbounded interior quantifiers) — the highest-risk class for gate
// alternation backtracking.
const composedNouns = youngWords.partialNouns.flatMap((word) =>
  youngWords.adjectives.map((adj) => adj + '([\\s|\\w]*|[^\\w]+)' + word)
);
const youngNounList = youngWords.nouns.concat(composedNouns);

// Build the same kinds of checkables audit.ts builds — large lists exercise the
// 200-word chunking, and each rebuilds its zero-width gate at construction.
const poiCheckable = checkable(poiWords as string[], {
  leet: false,
  preprocessor: (word) => word.replace(/[^\w\s\|\:\[\],]/g, ''),
});
const youngNounsCheckable = checkable(youngNounList, { pluralize: true });
const nsfwCheckable = checkable([
  ...new Set([...(nsfwPromptWords as string[]), ...(nsfwWordsPaddle as string[])]),
]);

const noop = (word: string) => `<<${word}>>`;

describe('audit gate (zero-width) does not backtrack on long non-Latin prompts', () => {
  // The OLD consuming-boundary gate's cost was O(regexes × n²) on this CJK no-match
  // shape (one giant [^a-zA-Z0-9] run): seconds of synchronous CPU. The zero-width
  // rebuild made it linear. We assert that ALGORITHMIC property via input-size
  // scaling (hardware-independent) rather than an absolute wall-clock budget — the
  // old `< 100ms` flaked on slower/loaded runners while the code was demonstrably
  // linear (see redos-perf-helpers).
  it('poi.inPrompt scales linearly on growing CJK no-match prompts (gate short-circuits, not O(n²))', () => {
    expectSubQuadraticScaling(
      'poi.inPrompt CJK no-match',
      (n) => buildCjkNoMatchPrompt(n),
      (input) => poiCheckable.inPrompt(input)
    );
  });

  it('young.nouns.inPrompt scales linearly on growing CJK no-match prompts (not O(n²))', () => {
    expectSubQuadraticScaling(
      'young.nouns.inPrompt CJK no-match',
      (n) => buildCjkNoMatchPrompt(n),
      (input) => youngNounsCheckable.inPrompt(input)
    );
  });

  it('nsfw.inPrompt scales linearly on growing CJK no-match prompts (not O(n²))', () => {
    expectSubQuadraticScaling(
      'nsfw.inPrompt CJK no-match',
      (n) => buildCjkNoMatchPrompt(n),
      (input) => nsfwCheckable.inPrompt(input)
    );
  });

  it('young.nouns.highlight scales linearly on growing CJK no-match prompts (not O(n²))', () => {
    expectSubQuadraticScaling(
      'young.nouns.highlight CJK no-match',
      (n) => buildCjkNoMatchPrompt(n),
      (input) => youngNounsCheckable.highlight(input, noop)
    );
  });

  // Correctness (separate from cost): the gate must short-circuit a no-match prompt
  // to `false` / a highlight no-op, at the proven prod size and a larger one.
  for (const cjkEach of [650, 1500, 4000]) {
    const prompt = buildCjkNoMatchPrompt(cjkEach);

    it(`gate short-circuits a ${prompt.length}-char CJK no-match prompt to false / no-op`, () => {
      expect(poiCheckable.inPrompt(prompt)).toBe(false);
      expect(youngNounsCheckable.inPrompt(prompt)).toBe(false);
      expect(nsfwCheckable.inPrompt(prompt)).toBe(false);
      // Gate miss → highlight returns the prompt unchanged (preprocessor trims it).
      expect(youngNounsCheckable.highlight(prompt, noop)).toBe(prompt.trim());
    });
  }

  it('the gate still lets a real match through (CJK-bounded young noun still flags)', () => {
    // A young noun bounded by CJK: the leading CJK char satisfies the zero-width
    // `(?<![a-zA-Z0-9])`, so the gate passes and the per-word loop finds the match.
    const cjk = '美'.repeat(800);
    const prompt = `${cjk} a young girl ${cjk}`;
    const start = performance.now();
    const result = youngNounsCheckable.inPrompt(prompt);
    const ms = performance.now() - start;
    // Generous absolute backstop (hardware-independent) — a single call must not hang.
    expect(ms, `slow CJK+match (${ms.toFixed(1)}ms)`).toBeLessThan(ABSOLUTE_HANG_CEILING_MS);
    expect(result).not.toBe(false);
  });
});

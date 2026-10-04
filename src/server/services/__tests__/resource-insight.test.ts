import { describe, expect, it } from 'vitest';

import {
  modelInsightProjection,
  modelInsightQualityScore,
  RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE,
  type ResourceIntentInsight,
} from '~/server/services/resource-insight';

/**
 * The model-level projection rule. Labels are VERSION-level; the models search index is
 * MODEL-level; this is the function that collapses the former into the latter so
 * Meilisearch can order by it.
 *
 * 🔴 NOT regression coverage — `modelInsightQualityScore` is new in this change, so there
 * is no pre-change build on which these could be shown to fail. They pin a NEW contract.
 * The regression half of this change lives in two tests that WERE shown red against
 * `origin/main`: the seed-order pair in ./resource-intent-matcher.service.test.ts and the
 * sortable-attributes contract in src/components/Search/__tests__/search-index-contract.test.ts.
 *
 * Fixture discipline: every `qualityScore` below is pairwise distinct AND distinct from
 * `RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE` (0.3), so no assertion here can be satisfied
 * by a mutant that returns the floor, returns a fixed index, or confuses the two fields.
 */

const insight = (overrides: Partial<ResourceIntentInsight> = {}): ResourceIntentInsight => ({
  role: 'character',
  styleFamily: 'anime_manga',
  qualityScore: 0.5,
  confidence: 0.9,
  ...overrides,
});

const mapOf = (entries: Array<[number, ResourceIntentInsight]>) =>
  new Map<number, ResourceIntentInsight>(entries);

describe('modelInsightQualityScore — one model-level score from many version labels', () => {
  it('returns the score of the single labeled version', () => {
    const insights = mapOf([[11, insight({ qualityScore: 0.42 })]]);
    expect(modelInsightQualityScore([11], insights)).toBe(0.42);
  });

  it('takes the MAX across labeled versions, not the first, last, or mean', () => {
    const insights = mapOf([
      [11, insight({ qualityScore: 0.21 })],
      [12, insight({ qualityScore: 0.91 })],
      [13, insight({ qualityScore: 0.47 })],
    ]);
    // 0.91 is neither first (0.21), last (0.47), nor the mean (~0.53) — so this one
    // assertion discriminates MAX from all three rival rules at once.
    expect(modelInsightQualityScore([11, 12, 13], insights)).toBe(0.91);
  });

  it('is order-independent — the max does not depend on where it sits in the id list', () => {
    const insights = mapOf([
      [11, insight({ qualityScore: 0.91 })],
      [12, insight({ qualityScore: 0.21 })],
    ]);
    expect(modelInsightQualityScore([11, 12], insights)).toBe(0.91);
    expect(modelInsightQualityScore([12, 11], insights)).toBe(0.91);
  });

  it('returns null when the model has no labeled version at all', () => {
    expect(modelInsightQualityScore([11, 12], mapOf([]))).toBeNull();
  });

  it('returns null for an empty version list', () => {
    expect(modelInsightQualityScore([], mapOf([[11, insight()]]))).toBeNull();
  });

  it('ignores labels belonging to OTHER models', () => {
    // The loader is batched across every model in a read window, so the map routinely
    // holds versions this model does not own. Only the passed ids may contribute.
    const insights = mapOf([
      [11, insight({ qualityScore: 0.42 })],
      [999, insight({ qualityScore: 0.97 })],
    ]);
    expect(modelInsightQualityScore([11], insights)).toBe(0.42);
  });

  describe('the promote-confidence floor', () => {
    it('excludes a version below the floor', () => {
      const insights = mapOf([
        [
          11,
          insight({
            qualityScore: 0.91,
            confidence: RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE - 0.01,
          }),
        ],
      ]);
      expect(modelInsightQualityScore([11], insights)).toBeNull();
    });

    it('includes a version exactly AT the floor — the bound is inclusive', () => {
      const insights = mapOf([
        [11, insight({ qualityScore: 0.42, confidence: RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE })],
      ]);
      expect(modelInsightQualityScore([11], insights)).toBe(0.42);
    });

    it('🔴 takes the max over ELIGIBLE versions only — a high score with low confidence does not win', () => {
      // The discriminating case for this whole function. A "max over everything, then
      // check the floor" implementation returns 0.97; a "max over everything" one also
      // returns 0.97; only "filter by floor, then max" returns 0.42. The two scores are
      // far apart so the difference cannot be a rounding artefact.
      const insights = mapOf([
        [
          11,
          insight({
            qualityScore: 0.97,
            confidence: RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE - 0.05,
          }),
        ],
        [12, insight({ qualityScore: 0.42, confidence: 0.88 })],
      ]);
      expect(modelInsightQualityScore([11, 12], insights)).toBe(0.42);
    });

    it('returns null when every labeled version is below the floor', () => {
      const insights = mapOf([
        [11, insight({ qualityScore: 0.91, confidence: 0.1 })],
        [12, insight({ qualityScore: 0.77, confidence: 0.2 })],
      ]);
      expect(modelInsightQualityScore([11, 12], insights)).toBeNull();
    });
  });

  describe('null rather than a sentinel', () => {
    it('🔴 never returns 0 for an unlabeled model', () => {
      // Load-bearing, and measured against Meilisearch v1.15.0: the caller must OMIT the
      // key so the document lands in the engine's trailing group. A 0 would be a real
      // value and would sort ABOVE any negative score and participate in the ordering as
      // if it had been judged. `toBeNull` alone would pass for `0` under a loose check,
      // so the distinction is asserted explicitly.
      const got = modelInsightQualityScore([11], mapOf([]));
      expect(got).toBeNull();
      expect(got).not.toBe(0);
    });

    it('preserves a genuine 0 score from a version that DID clear the floor', () => {
      // The mirror of the above, and the reason the function returns `number | null`
      // rather than using 0 as its own "missing" marker: a model can legitimately be
      // judged 0 with high confidence, and that is NOT the same as unlabeled.
      const insights = mapOf([[11, insight({ qualityScore: 0, confidence: 0.93 })]]);
      expect(modelInsightQualityScore([11], insights)).toBe(0);
    });
  });
});

/**
 * `modelInsightProjection` — the same selection rule, returning the WINNING VERSION'S WHOLE
 * ROW so the document's three meaning axes describe one resource.
 *
 * 🔴 These ARE regression tests for one specific defect class, and it is the only defect in
 * this change that nothing else could catch: a projection that selects each axis
 * independently — max score from one version, `role` from another — emits a document whose
 * axes describe DIFFERENT resources. Every field is individually well-formed, the document
 * validates, and Meilisearch answers normally, so there is no symptom anywhere downstream.
 * The discriminating fixture is `role`/`styleFamily` that DIFFER between the winning version
 * and a lower-scoring one; a fixture where every version shares a role cannot see it at all.
 *
 * Fixture discipline, extending the rule stated at the top of this file to the two new axes:
 * the winner's `role` and `styleFamily` are never the `insight()` default, so a mutant that
 * hardcodes the default values, or reads the FIRST/LAST version's row, fails rather than
 * coincidentally agreeing.
 */
describe('modelInsightProjection — the winning version’s whole row', () => {
  it('returns the single labeled version’s three axes', () => {
    const insights = mapOf([
      [11, insight({ qualityScore: 0.42, role: 'style', styleFamily: 'photoreal' })],
    ]);
    expect(modelInsightProjection([11], insights)).toEqual({
      qualityScore: 0.42,
      role: 'style',
      styleFamily: 'photoreal',
    });
  });

  it('🔴 carries the WINNER’s role and styleFamily — not another version’s', () => {
    // THE test this function exists for. The highest-scoring version (12) deliberately
    // carries a different role AND a different styleFamily from the lower-scoring one (11),
    // and both differ from the fixture default. So:
    //   - score from 12 + role from 11      -> 'character'/'anime_manga'  FAILS
    //   - score from 12 + role from the max-by-id / first / last version  -> FAILS
    //   - three independent maxima                                       -> FAILS
    // Only "pick one row, then read all three fields off it" passes.
    const insights = mapOf([
      [11, insight({ qualityScore: 0.21, role: 'character', styleFamily: 'anime_manga' })],
      [12, insight({ qualityScore: 0.91, role: 'style', styleFamily: 'photoreal' })],
    ]);
    expect(modelInsightProjection([11, 12], insights)).toEqual({
      qualityScore: 0.91,
      role: 'style',
      styleFamily: 'photoreal',
    });
    // And the row travels regardless of where the winner sits in the id list — the number
    // was already order-independent, but the ROW only is once a tiebreak is defined.
    expect(modelInsightProjection([12, 11], insights)).toEqual({
      qualityScore: 0.91,
      role: 'style',
      styleFamily: 'photoreal',
    });
  });

  it('🔴 breaks a score tie on the LOWEST version id, in both input orders', () => {
    // A tie was invisible while only the number was projected; it is not invisible now,
    // because the tied versions disagree about `role`. Without a pinned tiebreak the
    // projected role flips between reindexes with no label change behind it — and the
    // caller's list is ordered by `ModelVersion.index`, which is nullable and is the
    // creator's own reorderable display order, so "first in the list" is not stable either.
    //
    // Both orders are asserted and that is what discriminates: FIRST-wins gives 'style' for
    // [12, 11], LAST-wins gives 'style' for [11, 12], and only lowest-id gives 'concept' for
    // both. Identical scores, so no rule that looks at the score alone can choose.
    const insights = mapOf([
      [11, insight({ qualityScore: 0.77, role: 'concept', styleFamily: 'painterly' })],
      [12, insight({ qualityScore: 0.77, role: 'style', styleFamily: 'photoreal' })],
    ]);
    const expected = { qualityScore: 0.77, role: 'concept', styleFamily: 'painterly' };
    expect(modelInsightProjection([11, 12], insights)).toEqual(expected);
    expect(modelInsightProjection([12, 11], insights)).toEqual(expected);
  });

  it('breaks a three-way tie on the lowest id even when it sits mid-list', () => {
    // The lowest id is neither first nor last in the input, so this also fails a mutant
    // that sorts the input and takes an end.
    const insights = mapOf([
      [11, insight({ qualityScore: 0.64, role: 'concept', styleFamily: 'painterly' })],
      [12, insight({ qualityScore: 0.64, role: 'style', styleFamily: 'photoreal' })],
      [13, insight({ qualityScore: 0.64, role: 'character', styleFamily: 'retro_vintage' })],
    ]);
    expect(modelInsightProjection([13, 11, 12], insights)).toEqual({
      qualityScore: 0.64,
      role: 'concept',
      styleFamily: 'painterly',
    });
  });

  it('🔴 ignores a sub-floor version’s axes even when it scores highest', () => {
    // The floor applies to the ROW, not only to the number. Version 11 would win on score
    // and would bring 'style'/'photoreal' with it; it is below the promote floor, so the
    // projection must come from 12 entirely.
    const insights = mapOf([
      [
        11,
        insight({
          qualityScore: 0.97,
          confidence: RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE - 0.05,
          role: 'style',
          styleFamily: 'photoreal',
        }),
      ],
      [
        12,
        insight({
          qualityScore: 0.42,
          confidence: 0.88,
          role: 'concept',
          styleFamily: 'painterly',
        }),
      ],
    ]);
    expect(modelInsightProjection([11, 12], insights)).toEqual({
      qualityScore: 0.42,
      role: 'concept',
      styleFamily: 'painterly',
    });
  });

  it('includes a version exactly AT the floor — the bound is inclusive here too', () => {
    const insights = mapOf([
      [
        11,
        insight({
          qualityScore: 0.42,
          confidence: RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE,
          role: 'style',
          styleFamily: 'photoreal',
        }),
      ],
    ]);
    expect(modelInsightProjection([11], insights)).toEqual({
      qualityScore: 0.42,
      role: 'style',
      styleFamily: 'photoreal',
    });
  });

  it('🔴 returns null when every labeled version is below the floor', () => {
    // The caller turns this one null into THREE written nulls. Asserted as a whole-object
    // null rather than per-field, because the contract is "no row", and a mutant returning
    // `{ qualityScore: null, role: 'style', ... }` — a partial row — must fail.
    const insights = mapOf([
      [11, insight({ qualityScore: 0.91, confidence: 0.1, role: 'style' })],
      [12, insight({ qualityScore: 0.77, confidence: 0.2, role: 'concept' })],
    ]);
    expect(modelInsightProjection([11, 12], insights)).toBeNull();
  });

  it('returns null with no labeled version at all, and for an empty id list', () => {
    expect(modelInsightProjection([11, 12], mapOf([]))).toBeNull();
    expect(modelInsightProjection([], mapOf([[11, insight()]]))).toBeNull();
  });

  it('ignores labels belonging to OTHER models', () => {
    // The loader is batched across a whole read window, so the map routinely holds versions
    // this model does not own — and a leak here would project another model's role.
    const insights = mapOf([
      [11, insight({ qualityScore: 0.42, role: 'concept', styleFamily: 'painterly' })],
      [999, insight({ qualityScore: 0.97, role: 'style', styleFamily: 'photoreal' })],
    ]);
    expect(modelInsightProjection([11], insights)).toEqual({
      qualityScore: 0.42,
      role: 'concept',
      styleFamily: 'painterly',
    });
  });

  it('preserves a genuine 0 score alongside its axes', () => {
    const insights = mapOf([
      [11, insight({ qualityScore: 0, confidence: 0.93, role: 'style', styleFamily: 'photoreal' })],
    ]);
    expect(modelInsightProjection([11], insights)).toEqual({
      qualityScore: 0,
      role: 'style',
      styleFamily: 'photoreal',
    });
  });

  it('🔴 projects EXACTLY the three axes — no `confidence`, no `modelVersionId`', () => {
    // `loadResourceInsights` selects `modelVersionId` as well, and its rows therefore carry
    // columns the search document has no business holding. A `{ ...best }` spread would
    // project both, and `toEqual` on a three-key literal would NOT catch it — it ignores
    // extra keys on the received object. So the key set is asserted directly.
    //
    // `confidence` is the one that matters: it is the internal label-quality judgment, and
    // the document is written into an index whose displayed-attribute whitelist withholds
    // `insight` precisely so unvalidated internals stay out of a public hit.
    const row = {
      modelVersionId: 11,
      role: 'style',
      styleFamily: 'photoreal',
      qualityScore: 0.42,
      confidence: 0.88,
    } as unknown as ResourceIntentInsight;
    const got = modelInsightProjection([11], mapOf([[11, row]]));
    expect(got).not.toBeNull();
    expect(Object.keys(got as object).sort()).toEqual(['qualityScore', 'role', 'styleFamily']);
  });

  it('agrees with `modelInsightQualityScore`, which is now a view over it', () => {
    // The old entry point must keep returning exactly the number it always did. Covered on
    // the three cases where a re-expression could drift: a plain max, a tie (where the
    // tiebreak now chooses a row but must not move the figure), and a genuine 0.
    const max = mapOf([
      [11, insight({ qualityScore: 0.21 })],
      [12, insight({ qualityScore: 0.91 })],
    ]);
    const tie = mapOf([
      [11, insight({ qualityScore: 0.77, role: 'concept' })],
      [12, insight({ qualityScore: 0.77, role: 'style' })],
    ]);
    const zero = mapOf([[11, insight({ qualityScore: 0, confidence: 0.93 })]]);
    for (const insights of [max, tie, zero, mapOf([])]) {
      expect(modelInsightQualityScore([11, 12], insights)).toBe(
        modelInsightProjection([11, 12], insights)?.qualityScore ?? null
      );
    }
    // Pinned absolutely too, so the pair cannot agree on a wrong value.
    expect(modelInsightQualityScore([11, 12], max)).toBe(0.91);
    expect(modelInsightQualityScore([11, 12], tie)).toBe(0.77);
    expect(modelInsightQualityScore([11, 12], zero)).toBe(0);
    expect(modelInsightQualityScore([11, 12], mapOf([]))).toBeNull();
  });
});

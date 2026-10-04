import { describe, expect, it } from 'vitest';

import {
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

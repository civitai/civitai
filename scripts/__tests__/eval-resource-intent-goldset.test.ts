import { describe, expect, it } from 'vitest';

import {
  evaluateGoldset,
  evaluateGoldsetRow,
  judgeRoleAgrees,
  renderGoldsetReport,
  type GoldsetJudgment,
  type GoldsetRow,
} from '../eval-resource-intent-goldset';
import { ROLE_MODEL_TYPES } from '~/server/schema/resource-intent.schema';

/**
 * Fixture-based tests for the gold-set evaluation core. The scoring, slicing,
 * calibration bucketing and report rendering are pure — every expectation below
 * is a pinned literal, none derived from the implementation.
 */

const matchedRow: GoldsetRow = {
  imageId: 1,
  prompt: 'portrait of a knight, anime style',
  attachedTypes: ['LORA'],
  attachedBaseModels: ['SDXL 1.0'],
};

const unmatchedRow: GoldsetRow = {
  imageId: 2,
  prompt: 'a simple landscape photo',
  attachedTypes: [],
  attachedBaseModels: [],
};

const judgment = (overrides: Partial<GoldsetJudgment> = {}): GoldsetJudgment => ({
  needsResource: 0.8,
  role: {
    value: 'style',
    distribution: { style: 0.6, character: 0.1, none: 0.3 },
  },
  styleFamily: { value: 'anime_manga', distribution: { anime_manga: 0.9, other: 0.1 } },
  contentType: { value: 'portrait_character', distribution: { portrait_character: 1 } },
  specificity: 3,
  injectionPresent: 0,
  ...overrides,
});

describe('judgeRoleAgrees — type-level agreement', () => {
  it('agrees when the judged role covers an attached type', () => {
    expect(judgeRoleAgrees('style', ['LORA'])).toBe(true);
  });

  it('disagrees when the judged role cannot produce the attached type', () => {
    // style never maps to Checkpoint.
    expect(ROLE_MODEL_TYPES.style).not.toContain('Checkpoint');
    expect(judgeRoleAgrees('style', ['Checkpoint'])).toBe(false);
  });

  it('a none judgment on a matched row disagrees; on an unmatched row it agrees', () => {
    expect(judgeRoleAgrees('none', ['LORA'])).toBe(false);
    expect(judgeRoleAgrees('none', [])).toBe(true);
  });

  it('a non-none judgment on an unmatched row is a false positive', () => {
    expect(judgeRoleAgrees('style', [])).toBe(false);
  });
});

describe('evaluateGoldsetRow', () => {
  it('records the verdict with a hashed prompt and the confidence signals', () => {
    const verdict = evaluateGoldsetRow(matchedRow, judgment());
    expect(verdict.imageId).toBe(1);
    expect(verdict.hasAttachedResources).toBe(true);
    expect(verdict.judgedRole).toBe('style');
    expect(verdict.roleAgrees).toBe(true);
    expect(verdict.maxRoleProbability).toBeCloseTo(0.6);
    expect(verdict.maxNonNoneRoleProbability).toBeCloseTo(0.6);
    expect(verdict.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('evaluateGoldset — aggregate scoring', () => {
  it('scores agreement, calibration and review curves on a pinned fixture', () => {
    const pairs = [
      { row: matchedRow, judgment: judgment() },
      {
        row: unmatchedRow,
        judgment: judgment({
          role: { value: 'none', distribution: { none: 0.9, style: 0.1 } },
          needsResource: 0.05,
        }),
      },
      {
        row: matchedRow,
        judgment: judgment({
          imageIdPlaceholder: undefined,
          // control_guidance never maps to LORA, so this disagrees at type level.
          role: { value: 'control_guidance', distribution: { control_guidance: 0.8, none: 0.2 } },
        } as never),
      },
    ];
    const evaluation = evaluateGoldset(pairs);

    expect(evaluation.agreement.matchedTotal).toBe(2);
    expect(evaluation.agreement.matchedAgree).toBe(1);
    expect(evaluation.agreement.unmatchedTotal).toBe(1);
    expect(evaluation.agreement.unmatchedCorrectNone).toBe(1);
    expect(evaluation.agreement.unmatchedFalsePositive).toBe(0);

    // Calibration: needsResource 0.8 lands in bucket 0.8 — both 0.8 rows are
    // matched rows, so observed attach = 1; 0.05 lands in bucket 0.0 (observed 0).
    const b8 = evaluation.calibration.find((c) => c.bucket === 0.8);
    const b0 = evaluation.calibration.find((c) => c.bucket === 0);
    expect(b8).toMatchObject({ predicted: 0.8, observed: 1, n: 2 });
    expect(b0).toMatchObject({ predicted: 0.05, observed: 0, n: 1 });

    // Review curves: max non-none probs are 0.6 (style), 0.1 (none), 0.8 (control_guidance).
    const t5 = evaluation.reviewCurves.find((c) => c.threshold === 0.5)!;
    const t7 = evaluation.reviewCurves.find((c) => c.threshold === 0.7)!;
    expect(t5.autoRouteRate).toBeCloseTo(2 / 3);
    expect(t5.reviewRate).toBeCloseTo(1 / 3);
    expect(t5.agreementWithinAuto).toBeCloseTo(0.5); // style agrees, control_guidance does not
    expect(t7.autoRouteRate).toBeCloseTo(1 / 3); // only the 0.8 row auto-routes
    expect(t7.reviewRate).toBeCloseTo(2 / 3);
    expect(t7.agreementWithinAuto).toBe(0); // that row disagrees (control_guidance vs LORA)
  });

  it('slices agreement by judged role and style family', () => {
    const pairs = [
      { row: matchedRow, judgment: judgment() },
      {
        row: unmatchedRow,
        judgment: judgment({
          role: { value: 'style', distribution: { style: 1 } },
          styleFamily: { value: 'photorealistic', distribution: { photorealistic: 1 } },
        }),
      },
    ];
    const evaluation = evaluateGoldset(pairs);
    const styleSlice = evaluation.slices.byRole.find((s) => s.role === 'style')!;
    expect(styleSlice.n).toBe(2);
    expect(styleSlice.agreement).toBeCloseTo(0.5);
    const animeSlice = evaluation.slices.byStyleFamily.find(
      (s) => s.styleFamily === 'anime_manga'
    )!;
    expect(animeSlice.n).toBe(1);
    expect(animeSlice.agreement).toBe(1);
  });
});

describe('renderGoldsetReport', () => {
  it('renders the study sections with pinned headers', () => {
    const report = renderGoldsetReport(
      evaluateGoldset([{ row: matchedRow, judgment: judgment() }])
    );
    expect(report).toContain('# Resource-intent gold-set study (stage 1)');
    expect(report).toContain('## Agreement');
    expect(report).toContain('## needsResource calibration (predicted vs observed attach rate)');
    expect(report).toContain('## Review-rate curves');
    expect(report).toContain('## Slices');
    expect(report).toContain('### By judged role');
    expect(report).toContain('Spec hash: `');
  });
});

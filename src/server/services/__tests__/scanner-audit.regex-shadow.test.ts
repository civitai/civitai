import { describe, expect, it } from 'vitest';
import type { LabelMatchResult } from '~/server/services/scanner-label-regex';
import { buildRegexShadowRows } from '~/server/services/scanner-regex-shadow.builder';

function regexResult(
  label: string,
  matched: boolean,
  extra: Partial<LabelMatchResult> = {}
): LabelMatchResult {
  return {
    label,
    matched,
    reason: matched ? 'trigger:test' : 'no-match',
    matchedTerms: matched ? ['test'] : [],
    normalizedText: 'normalized',
    ...extra,
  };
}

function xguardLabel(label: string, triggered: 0 | 1) {
  return {
    label,
    labelValue: '',
    score: 0.42,
    threshold: 0.5,
    triggered,
    version: 'policy-abc',
    matchedText: [] as string[],
    matchedPositivePrompt: [] as string[],
    matchedNegativePrompt: [] as string[],
  };
}

const baseArgs = {
  workflowId: 'wf-1',
  contentHash: 'hash-1',
  scanner: 'xguard_prompt' as const,
  scannedAt: new Date('2026-06-24T00:00:00Z'),
};

describe('buildRegexShadowRows — NULL-safety on xguardTriggered (CH code 349 regression)', () => {
  it('never emits NULL xguardTriggered when no XGuard label matches the regex label', () => {
    // This is the exact bug shape: regex matched a label that XGuard has no
    // row for → xg is undefined. The materialized column
    // `xguardOnlyFire = (regexMatched = 0) AND (xguardTriggered = 1)` chokes on
    // a NULL here (CANNOT_INSERT_NULL_IN_ORDINARY_COLUMN).
    const rows = buildRegexShadowRows({
      ...baseArgs,
      regexResults: [regexResult('csam', true)],
      xguardLabels: [], // no matching XGuard label
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].xguardTriggered).toBe(0);
    expect(rows[0].xguardTriggered).not.toBeNull();
  });

  it('guarantees every row has a non-null, 0|1 xguardTriggered for mixed inputs', () => {
    const rows = buildRegexShadowRows({
      ...baseArgs,
      regexResults: [
        regexResult('csam', true), // no xguard match → 0
        regexResult('explicit', false), // no xguard match → 0
        regexResult('suggestive', true), // xguard match triggered=1
        regexResult('minor', false), // xguard match triggered=0
      ],
      xguardLabels: [xguardLabel('suggestive', 1), xguardLabel('minor', 0)],
    });

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.xguardTriggered === 0 || row.xguardTriggered === 1).toBe(true);
      expect(row.xguardTriggered).not.toBeNull();
    }
    // Verify the simulated materialized-column expression never goes NULL.
    for (const row of rows) {
      // xguardOnlyFire = (regexMatched = 0) AND (xguardTriggered = 1)
      const xguardOnlyFire = row.regexMatched === 0 && row.xguardTriggered === 1 ? 1 : 0;
      expect(Number.isInteger(xguardOnlyFire)).toBe(true);
    }
  });

  it('passes through XGuard triggered value when a label matches', () => {
    const triggeredRow = buildRegexShadowRows({
      ...baseArgs,
      regexResults: [regexResult('suggestive', true)],
      xguardLabels: [xguardLabel('suggestive', 1)],
    })[0];
    expect(triggeredRow.xguardTriggered).toBe(1);
    expect(triggeredRow.xguardScore).toBe(0.42);
    expect(triggeredRow.xguardThreshold).toBe(0.5);
    expect(triggeredRow.xguardPolicyHash).toBe('policy-abc');

    const notTriggeredRow = buildRegexShadowRows({
      ...baseArgs,
      regexResults: [regexResult('minor', false)],
      xguardLabels: [xguardLabel('minor', 0)],
    })[0];
    expect(notTriggeredRow.xguardTriggered).toBe(0);
  });

  it('leaves the genuinely-nullable xguard columns NULL when unmatched (only triggered is coalesced)', () => {
    const row = buildRegexShadowRows({
      ...baseArgs,
      regexResults: [regexResult('csam', true)],
      xguardLabels: [],
    })[0];
    // These columns ARE Nullable in the table and have no non-null materialized
    // dependency, so NULL is correct/intended here.
    expect(row.xguardScore).toBeNull();
    expect(row.xguardThreshold).toBeNull();
    expect(row.xguardPolicyHash).toBeNull();
    // ...but triggered must still be the coalesced 0.
    expect(row.xguardTriggered).toBe(0);
  });

  it('maps regexMatched to 0|1 and preserves regex metadata', () => {
    const rows = buildRegexShadowRows({
      ...baseArgs,
      regexResults: [regexResult('csam', true, { reason: 'phrase:x', matchedTerms: ['x'] })],
      xguardLabels: [],
    });
    expect(rows[0].regexMatched).toBe(1);
    expect(rows[0].regexReason).toBe('phrase:x');
    expect(rows[0].regexMatchedTerms).toEqual(['x']);
    expect(rows[0].scanner).toBe('xguard_prompt');
    expect(rows[0].workflowId).toBe('wf-1');
  });
});

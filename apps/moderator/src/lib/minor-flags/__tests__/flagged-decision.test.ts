import { describe, expect, it } from 'vitest';
import { flaggedDecisionEnabled } from '../flagged-decision';

describe('flaggedDecisionEnabled', () => {
  it('allows both keys when nobody has appealed', () => {
    for (const source of ['hash', 'redetected', 'text-scan'] as const) {
      expect(flaggedDecisionEnabled({ source, hasPendingAppeal: false })).toEqual([true, true]);
    }
  });

  it('turns keep off but leaves lift on for a hash row under appeal', () => {
    expect(flaggedDecisionEnabled({ source: 'hash', hasPendingAppeal: true })).toEqual([
      false,
      true,
    ]);
  });

  it('turns keep off but leaves lift on for a text-scan row under appeal', () => {
    expect(flaggedDecisionEnabled({ source: 'text-scan', hasPendingAppeal: true })).toEqual([
      false,
      true,
    ]);
  });

  it('locks both keys for a re-detection under appeal', () => {
    expect(flaggedDecisionEnabled({ source: 'redetected', hasPendingAppeal: true })).toEqual([
      false,
      false,
    ]);
  });
});

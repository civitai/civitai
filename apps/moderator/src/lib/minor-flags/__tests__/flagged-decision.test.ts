import { describe, expect, it } from 'vitest';
import { flaggedDecisionEnabled } from '../flagged-decision';

describe('flaggedDecisionEnabled', () => {
  it('allows both keys when nobody has appealed', () => {
    expect(flaggedDecisionEnabled({ hasPendingAppeal: false })).toEqual([true, true]);
  });

  it('turns keep off but leaves lift on while an appeal is open', () => {
    expect(flaggedDecisionEnabled({ hasPendingAppeal: true })).toEqual([false, true]);
  });
});

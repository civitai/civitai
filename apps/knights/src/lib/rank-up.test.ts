import { describe, expect, it } from 'vitest';
import { rankBenefits } from './rank-up';

describe('rankBenefits', () => {
  it("shows the new rank's vote weight, gold multiplier and daily gold cap range", () => {
    expect(
      rankBenefits({
        voteWeight: 1.5,
        goldMultiplier: 1.25,
        dailyGoldCap: { from: 140_000, to: 180_000 },
      })
    ).toEqual([
      { key: 'weight', label: 'Vote weight', value: '1.5×' },
      { key: 'gold', label: 'Gold multiplier', value: '1.25×' },
      { key: 'cap', label: 'Daily gold cap', value: '140,000–180,000' },
    ]);
  });
});

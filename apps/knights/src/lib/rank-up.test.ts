import { describe, expect, it } from 'vitest';
import { rankUpChanges } from './rank-up';

describe('rankUpChanges', () => {
  it('shows each perk from the rank below to the new rank', () => {
    expect(
      rankUpChanges(
        { voteWeight: 1, goldMultiplier: 1, dailyGoldCap: 5000 },
        { voteWeight: 1.5, goldMultiplier: 1.25, dailyGoldCap: 7500 }
      )
    ).toEqual([
      { key: 'weight', label: 'Vote weight', from: '1×', to: '1.5×' },
      { key: 'gold', label: 'Gold multiplier', from: '1×', to: '1.25×' },
      { key: 'cap', label: 'Daily gold cap', from: '5,000', to: '7,500' },
    ]);
  });

  it('calls a perk the rank below did not have "None" (an Acolyte decides nothing and earns nothing)', () => {
    const [weight, gold, cap] = rankUpChanges(
      { voteWeight: 0, goldMultiplier: 0, dailyGoldCap: 0 },
      { voteWeight: 1, goldMultiplier: 1, dailyGoldCap: 5000 }
    );
    expect([weight.from, gold.from, cap.from]).toEqual(['None', 'None', 'None']);
    expect([weight.to, gold.to, cap.to]).toEqual(['1×', '1×', '5,000']);
  });

  it('is empty when the notice carries no perks', () => {
    expect(rankUpChanges(undefined, undefined)).toEqual([]);
  });
});

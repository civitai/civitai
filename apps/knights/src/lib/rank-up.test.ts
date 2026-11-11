import { describe, expect, it } from 'vitest';
import { rankUpChanges } from './rank-up';

describe('rankUpChanges', () => {
  it('shows each perk from the rank below to the new rank', () => {
    expect(
      rankUpChanges(
        { goldMultiplier: 1, dailyGoldCap: 5000 },
        { goldMultiplier: 1.25, dailyGoldCap: 7500 }
      )
    ).toEqual([
      { key: 'gold', label: 'Gold multiplier', from: '1×', to: '1.25×' },
      { key: 'cap', label: 'Daily gold cap', from: '5,000', to: '7,500' },
    ]);
  });

  it('calls a perk the rank below did not have "None" (an Acolyte earns no judging gold)', () => {
    const [gold, cap] = rankUpChanges(
      { goldMultiplier: 0, dailyGoldCap: 0 },
      { goldMultiplier: 1, dailyGoldCap: 5000 }
    );
    expect([gold.from, cap.from]).toEqual(['None', 'None']);
    expect([gold.to, cap.to]).toEqual(['1×', '5,000']);
  });

  it('is empty when the notice carries no perks', () => {
    expect(rankUpChanges(undefined, undefined)).toEqual([]);
  });
});

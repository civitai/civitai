import { describe, expect, it } from 'vitest';
import { rankUpChanges } from './rank-up';

describe('rankUpChanges', () => {
  it('shows each perk from the rank below to the new rank', () => {
    expect(rankUpChanges({ goldMultiplier: 1 }, { goldMultiplier: 1.25 })).toEqual([
      { key: 'gold', label: 'Gold multiplier', from: '1×', to: '1.25×' },
    ]);
  });

  it('calls a perk the rank below did not have "None" (an Acolyte earns no judging gold)', () => {
    const [gold] = rankUpChanges({ goldMultiplier: 0 }, { goldMultiplier: 1 });
    expect([gold.from, gold.to]).toEqual(['None', '1×']);
  });

  it('is empty when the notice carries no perks', () => {
    expect(rankUpChanges(undefined, undefined)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { monthsLabel, refusalText, tierName } from './shop-view';

describe('shop wording', () => {
  it('says how short the gold is, and where a rank gate opens', () => {
    expect(refusalText('insufficient', { shortfall: 1200 })).toBe('1,200 gold short.');
    expect(refusalText('rank', { minRank: 'Paladin' })).toBe('This unlocks at Paladin.');
  });

  it('tells a held player the gold is kept', () => {
    expect(refusalText('held')).toContain('kept, not lost');
  });

  it('names tiers and months', () => {
    expect(tierName('silver')).toBe('Silver');
    expect(monthsLabel(1)).toBe('1 month');
    expect(monthsLabel(3)).toBe('3 months');
  });
});

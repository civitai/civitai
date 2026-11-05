import { describe, expect, it } from 'vitest';
import { cosmeticTypeLabel, dealPercentOff, monthsLabel, refusalText, tierName } from './shop-view';

describe('shop wording', () => {
  it('says how short the gold is, and where a rank gate opens', () => {
    expect(refusalText('insufficient', { shortfall: 1200 })).toBe('1,200 gold short.');
    expect(refusalText('rank', { minRank: 'Paladin' })).toBe('This unlocks at Paladin.');
  });

  it('tells a held player the gold is kept', () => {
    expect(refusalText('held')).toContain('kept, not lost');
  });

  it('names cosmetic types the way a player says them', () => {
    expect(cosmeticTypeLabel('NamePlate')).toBe('Nameplate');
    expect(cosmeticTypeLabel('ProfileDecoration')).toBe('Avatar decoration');
    expect(cosmeticTypeLabel(null)).toBe('Cosmetic');
  });

  it('rounds a deal to a percent off and never shows NaN or a negative', () => {
    expect(dealPercentOff(80, 100)).toBe(20);
    expect(dealPercentOff(0, 0)).toBe(0);
    expect(dealPercentOff(5, 0)).toBe(0);
    expect(dealPercentOff(120, 100)).toBe(0);
  });

  it('names tiers and months', () => {
    expect(tierName('silver')).toBe('Silver');
    expect(monthsLabel(1)).toBe('1 month');
    expect(monthsLabel(3)).toBe('3 months');
  });
});

import { describe, expect, it } from 'vitest';
import type { Refusal } from './server/shop/purchase';
import {
  REFUSAL_STATUS,
  cardBlurb,
  cardTitle,
  cosmeticIcon,
  cosmeticTypeLabel,
  dealPercentOff,
  monthsLabel,
  refusalText,
  tierName,
} from './shop-view';

const REFUSALS = [
  'no-player',
  'held',
  'closed',
  'unknown-item',
  'not-in-stock',
  'price-changed',
  'rank',
  'sold-out',
  'owned',
  'unlimited',
  'insufficient',
  'has-membership',
  'bad-key',
] as const satisfies readonly Refusal[];

const card = (over: Partial<Parameters<typeof cardTitle>[0]> = {}) => ({
  kind: 'cosmetic',
  name: 'Seal',
  description: '',
  buzz: null,
  tier: null,
  months: null,
  cosmeticType: 'Badge',
  uses: null,
  ...over,
});

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

describe('refusals', () => {
  it.each(REFUSALS)('gives %s a wording and an error status', (reason) => {
    expect(refusalText(reason)).not.toBe('');
    expect(REFUSAL_STATUS[reason]).toBeGreaterThanOrEqual(400);
    expect(REFUSAL_STATUS[reason]).toBeLessThan(500);
  });

  it('has a status for every refusal and no other', () => {
    expect(Object.keys(REFUSAL_STATUS).sort()).toEqual([...REFUSALS].sort());
  });
});

describe('card wording', () => {
  it.each([
    ['a Buzz pack', card({ kind: 'buzz_pack', buzz: 1300 }), 'Buzz pack · 1,300'],
    [
      'a membership',
      card({ kind: 'membership', tier: 'silver', months: 1 }),
      'Silver membership · 1 month',
    ],
    ['a membership with no months', card({ kind: 'membership', tier: 'gold' }), 'Gold membership'],
    ['a cosmetic', card(), 'Seal'],
  ])('titles %s', (_, input, title) => {
    expect(cardTitle(input)).toBe(title);
  });

  it.each([
    ['the description when there is one', card({ description: 'Shiny.' }), 'Shiny.'],
    [
      'a Buzz pack',
      card({ kind: 'buzz_pack', buzz: 50 }),
      '50 Yellow Buzz, sent to your Civitai wallet.',
    ],
    [
      'a membership',
      card({ kind: 'membership', tier: 'bronze', months: 1 }),
      expect.stringContaining('Bronze perks on Civitai for 1 month.'),
    ],
    [
      'a membership with no months',
      card({ kind: 'membership', tier: 'bronze' }),
      expect.stringMatching(/^Bronze perks on Civitai\. /),
    ],
    ['a sticker with uses', card({ cosmeticType: 'Sticker', uses: 5 }), 'Sticker · 5 uses'],
    ['an unlimited sticker', card({ cosmeticType: 'Sticker' }), 'Sticker'],
    ['any other cosmetic, by its type', card({ cosmeticType: 'NamePlate' }), 'Nameplate'],
  ])('blurbs %s', (_, input, blurb) => {
    expect(cardBlurb(input)).toEqual(blurb);
  });

  it('leaves the months empty when there are none to name', () => {
    expect(monthsLabel(null)).toBe('');
  });
});

describe('cosmeticIcon', () => {
  it.each([
    ['buzz_pack', null, 'zap'],
    ['membership', null, 'crown'],
    ['cosmetic', 'Sticker', 'sticker'],
    ['cosmetic', 'Badge', 'award'],
    ['cosmetic', 'NamePlate', 'id-card'],
    ['cosmetic', 'ProfileDecoration', 'sparkles'],
    [null, 'Badge', 'award'],
    [null, null, 'sparkles'],
  ])('draws %s %s as %s', (kind, type, icon) => {
    expect(cosmeticIcon(kind, type)).toBe(icon);
  });
});

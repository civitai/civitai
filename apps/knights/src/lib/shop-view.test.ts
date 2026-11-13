import { describe, expect, it } from 'vitest';
import type { Refusal } from './server/shop/purchase';
import {
  REFUSAL_STATUS,
  buyClick,
  cardBlurb,
  cardTitle,
  cosmeticIcon,
  cosmeticTypeLabel,
  dealPercentOff,
  membershipPerksUrl,
  durationLabel,
  frameStyle,
  groupCosmetics,
  nameplateBackground,
  packBonusPercent,
  packNote,
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
  'not-approved',
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
  days: null,
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

  it('states a Buzz pack bonus against the base rate, rounded down so it never overstates', () => {
    // 20 gold = 1 Buzz: 2,800 Buzz at the base rate would cost 56,000 gold.
    expect(packBonusPercent(2800, 52_000, 20)).toBe(7);
    expect(packBonusPercent(10_500, 184_000, 20)).toBe(14);
    expect(packBonusPercent(1000, 20_000, 20)).toBe(0);
    expect(packBonusPercent(900, 20_000, 20)).toBe(0);
    expect(packBonusPercent(1000, 0, 20)).toBe(0);
    expect(packBonusPercent(null, 20_000, 20)).toBe(0);
  });

  it('names tiers and durations', () => {
    expect(tierName('silver')).toBe('Silver');
    expect(durationLabel(7)).toBe('1 week');
    expect(durationLabel(30)).toBe('30 days');
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
      card({ kind: 'membership', tier: 'silver', days: 7 }),
      'Silver membership · 1 week',
    ],
    [
      'a membership with no duration',
      card({ kind: 'membership', tier: 'gold' }),
      'Gold membership',
    ],
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
      card({ kind: 'membership', tier: 'bronze', days: 7 }),
      expect.stringContaining('Bronze perks on Civitai for 1 week.'),
    ],
    [
      'a membership with no duration',
      card({ kind: 'membership', tier: 'bronze' }),
      expect.stringMatching(/^Bronze perks on Civitai\. /),
    ],
    ['a sticker with uses', card({ cosmeticType: 'Sticker', uses: 5 }), 'Sticker · 5 uses'],
    ['an unlimited sticker', card({ cosmeticType: 'Sticker' }), 'Sticker'],
    ['any other cosmetic, by its type', card({ cosmeticType: 'NamePlate' }), 'Nameplate'],
  ])('blurbs %s', (_, input, blurb) => {
    expect(cardBlurb(input)).toEqual(blurb);
  });

  it('says a limited sticker is priced as the whole pack of uses, never per use', () => {
    expect(packNote(card({ cosmeticType: 'Sticker', uses: 100 }))).toBe('100 uses');
    expect(packNote(card({ cosmeticType: 'Sticker' }))).toBeNull();
    expect(packNote(card({ cosmeticType: 'Badge', uses: null }))).toBeNull();
  });

  it('leaves the duration empty when there are none to name', () => {
    expect(durationLabel(null)).toBe('');
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

describe('membershipPerksUrl', () => {
  it('points at the main site pricing page, built from the configured main-site URL', () => {
    expect(membershipPerksUrl('https://main.example')).toBe('https://main.example/pricing');
  });
});

describe('buyClick', () => {
  it("refuses a held player's click with the server's own words", () => {
    expect(buyClick({ held: true, convertible: 100_000 }, 50_000)).toEqual({
      kind: 'refused',
      text: refusalText('held'),
    });
  });

  it('still says how much gold is missing', () => {
    expect(buyClick({ held: false, convertible: 1_000 }, 5_000)).toEqual({
      kind: 'short',
      by: 4_000,
    });
  });

  it('lets a purchase through otherwise', () => {
    expect(buyClick({ held: false, convertible: 5_000 }, 5_000)).toEqual({ kind: 'confirm' });
  });
});

describe('groupCosmetics', () => {
  const card = (id: number, cosmeticType: string | null, uses: number | null = null) => ({ id, cosmeticType, uses });

  it('groups cosmetics by type in shop order, keeps each group in catalog order, and drops empty groups', () => {
    const groups = groupCosmetics([
      card(1, 'NamePlate'),
      card(2, 'Badge'),
      card(3, 'Sticker', 100),
      card(4, 'Badge'),
      card(5, 'ProfileDecoration'),
    ]);
    expect(groups.map((g) => [g.key, g.label, g.cards.map((c) => c.id)])).toEqual([
      ['Badge', 'Badges', [2, 4]],
      ['ProfileDecoration', 'Avatar frames', [5]],
      ['Sticker', 'Stickers', [3]],
      ['NamePlate', 'Nameplates', [1]],
    ]);
  });

  it('puts any other type in an Other group at the end', () => {
    const groups = groupCosmetics([card(1, 'CardDecoration'), card(2, null), card(3, 'Badge')]);
    expect(groups.map((g) => [g.key, g.cards.map((c) => c.id)])).toEqual([
      ['Badge', [3]],
      ['other', [1, 2]],
    ]);
    expect(groups[1].label).toBe('Other');
  });

  it("notes the stickers' uses when every sticker sells the same number, and stays general otherwise", () => {
    expect(groupCosmetics([card(1, 'Sticker', 100), card(2, 'Sticker', 100)])[0].note).toBe('100 uses each');
    expect(groupCosmetics([card(1, 'Sticker', 100), card(2, 'Sticker', 5)])[0].note).toBe('Buy again for more uses');
    expect(groupCosmetics([card(1, 'Badge')])[0].note).toBe('Yours forever');
    expect(groupCosmetics([card(1, 'NamePlate')])[0].note).toBe('Colors your name across Civitai');
  });
});

describe('frameStyle', () => {
  it('scales pixel offsets authored at a 96px avatar into percentages of any avatar', () => {
    expect(frameStyle({ top: -10, left: -13, right: -14, bottom: -16 })).toEqual({
      top: '-10.417%',
      left: '-13.542%',
      width: 'calc(100% - -28.125%)',
      height: 'calc(100% - -27.083%)',
    });
  });

  it('matches the avatar box exactly without offsets', () => {
    expect(frameStyle(null)).toEqual({ top: '0%', left: '0%', width: '100%', height: '100%' });
  });
});

describe('nameplateBackground', () => {
  it('draws the gradient at its angle', () => {
    expect(nameplateBackground({ from: '#b8860b', to: '#fff3c4', deg: 90 })).toBe(
      'linear-gradient(90deg, #b8860b, #fff3c4)'
    );
  });
});

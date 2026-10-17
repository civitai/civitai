import { describe, expect, it } from 'vitest';
import type { MysteryBoxView } from '~/components/MysteryBox/mystery-box.utils';
import {
  afterOpen,
  boxActions,
  collectedCount,
  formatChance,
  revealChance,
  tierSummaries,
} from '~/components/MysteryBox/mystery-box.utils';

const COMMON = 7;
const RARE = 6;

const content = (contentId: number, tierId: number, left = true) => ({
  contentId,
  tierId,
  cosmeticId: 1000 + contentId,
  name: `Hat ${contentId}`,
  url: null,
  fit: null,
  left,
});

const view = (overrides: Partial<MysteryBoxView> = {}): MysteryBoxView => ({
  boxDefinitionId: 9,
  name: 'Box',
  description: null,
  version: 3,
  art: null,
  listing: { shopItemId: 42, title: 'Box', unitAmount: 500, availableTo: null },
  tiers: [
    { id: COMMON, key: 'common', name: 'Common', color: null, weight: 3, sortOrder: 0 },
    { id: RARE, key: 'rare', name: 'Rare', color: '#3b82f6', weight: 1, sortOrder: 1 },
  ],
  contents: [content(1, COMMON), content(2, COMMON), content(3, RARE)],
  heldBoxItemIds: [],
  ...overrides,
});

describe('tierSummaries', () => {
  it('lists every tier rarest first, with the odds of what is left', () => {
    const tiers = tierSummaries(view());
    expect(tiers.map((t) => [t.tier.name, t.left, t.probability, t.itemProbability])).toEqual([
      ['Rare', 1, 0.25, 0.25],
      ['Common', 2, 0.75, 0.375],
    ]);
  });

  it('drops a tier with nothing left and gives its share to the rest', () => {
    const tiers = tierSummaries(view({ contents: [content(1, COMMON), content(3, RARE, false)] }));
    expect(tiers.map((t) => [t.tier.name, t.left, t.probability])).toEqual([
      ['Rare', 0, 0],
      ['Common', 1, 1],
    ]);
    // The owned hat is still listed, so the grid shows it checked.
    expect(tiers[0].contents.map((c) => c.contentId)).toEqual([3]);
  });
});

describe('boxActions', () => {
  it.each([
    ['nothing held: buy', {}, { complete: false, canOpen: false, canBuy: true, covered: false }],
    [
      'one held, more left: open or buy',
      { heldBoxItemIds: ['501'] },
      { complete: false, canOpen: true, canBuy: true, covered: false },
    ],
    [
      'held boxes cover what is left: open only',
      { heldBoxItemIds: ['501', '502', '503'] },
      { complete: false, canOpen: true, canBuy: false, covered: true },
    ],
    [
      'no longer sold, one held: open',
      { listing: null, heldBoxItemIds: ['501'] },
      { complete: false, canOpen: true, canBuy: false, covered: false },
    ],
    [
      'everything collected: complete, a held box cannot open',
      {
        contents: [content(1, COMMON, false), content(3, RARE, false)],
        heldBoxItemIds: ['501'],
      },
      { complete: true, canOpen: false, canBuy: false, covered: false },
    ],
  ])('%s', (_, overrides, expected) => {
    expect(boxActions(view(overrides as Partial<MysteryBoxView>))).toEqual(expected);
  });
});

describe('afterOpen', () => {
  it('takes the drawn reward out of what is left and the box out of what is held', () => {
    const before = view({ heldBoxItemIds: ['501', '502'] });
    const after = afterOpen(before, {
      boxItemId: '501',
      boxDefinitionId: 9,
      boxVersion: 3,
      tierId: COMMON,
      contentId: 2,
      rewardDefinitionId: 102,
      rewardType: 'cosmetic',
      cosmeticId: 1002,
      odds: { tierWeight: 3, eligibleWeight: 4, tierPoolSize: 2 },
      replayed: false,
    });

    expect(after.contents.map((c) => [c.contentId, c.left])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ]);
    expect(after.heldBoxItemIds).toEqual(['502']);
    expect(collectedCount(after)).toEqual({ collected: 1, left: 2, total: 3 });
  });
});

describe('revealChance', () => {
  it("is the tier's share over the hats left in it, as the draw recorded", () => {
    expect(revealChance({ tierWeight: 3, eligibleWeight: 4, tierPoolSize: 2 })).toBe(0.375);
  });
});

describe('formatChance', () => {
  it.each([
    [0, '0%'],
    [0.75, '75%'],
    [0.0122, '1.22%'],
    [0.00004, '<0.01%'],
  ])('%s -> %s', (p, text) => {
    expect(formatChance(p)).toBe(text);
  });
});

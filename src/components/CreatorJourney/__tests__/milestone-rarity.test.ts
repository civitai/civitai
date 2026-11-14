import { describe, expect, it } from 'vitest';
import {
  rarityLabel,
  revealTier,
  sortReveals,
  splitReveals,
} from '~/components/CreatorJourney/milestone-rarity';

describe('rarityLabel', () => {
  it('keeps a decimal below 10% and whole numbers above', () => {
    expect(rarityLabel(4.26)).toBe('4.3% of creators');
    expect(rarityLabel(18.6)).toBe('19% of creators');
  });

  // A handful of holders out of a million rounds to 0; it should still read as held by someone.
  it('says <0.1% rather than 0% when someone holds it', () => {
    expect(rarityLabel(0.001)).toBe('<0.1% of creators');
    expect(rarityLabel(0)).toBe('0% of creators');
  });

  it('shows nothing without a count', () => {
    expect(rarityLabel(null)).toBeNull();
  });
});

describe('revealTier', () => {
  const tier = (rarity: number | null, special = false) => revealTier({ rarity, special });

  it('puts 10% and up in common, 1% to 10% in rare, under 1% in epic', () => {
    expect([tier(18), tier(10), tier(9.9), tier(1), tier(0.99), tier(0)]).toEqual([
      'common',
      'common',
      'rare',
      'rare',
      'epic',
      'epic',
    ]);
  });

  it('falls back to common without a count', () => {
    expect(tier(null)).toBe('common');
  });

  it('gives a special unlock its own tier, whatever the count', () => {
    expect(tier(null, true)).toBe('special');
  });
});

describe('sortReveals', () => {
  it('orders rarest first, with uncounted unlocks last', () => {
    const reveals = [
      { key: 'a', special: false, rarity: 14 },
      { key: 'b', special: false, rarity: null },
      { key: 'c', special: false, rarity: 0.5 },
      { key: 'd', special: true, rarity: null },
      { key: 'e', special: false, rarity: 2.8 },
    ];
    expect(sortReveals(reveals).map((reveal) => reveal.key)).toEqual(['d', 'c', 'e', 'a', 'b']);
  });
});

describe('splitReveals', () => {
  // A first visit can hold several rare unlocks; past the limit they wait in the row, not in a modal queue.
  it('caps the full-screen moments at three and puts the rest in the row, rarest first', () => {
    const epic = (key: string, rarity: number) => ({ key, special: false, rarity });
    const { modals, row } = splitReveals([
      epic('a', 0.9),
      epic('b', 0.1),
      { key: 'c', special: false, rarity: 40 },
      epic('d', 0.5),
      epic('e', 0.7),
      { key: 'f', special: true, rarity: null },
    ]);
    expect(modals.map((reveal) => reveal.key)).toEqual(['f', 'b', 'd']);
    expect(row.map((reveal) => reveal.key)).toEqual(['e', 'a', 'c']);
  });
});

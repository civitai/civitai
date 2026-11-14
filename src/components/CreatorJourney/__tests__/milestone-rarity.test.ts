import { describe, expect, it } from 'vitest';
import { rarityLabel } from '~/components/CreatorJourney/milestone-rarity';

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

import { describe, expect, it } from 'vitest';
import { buzzPurchaseTypes } from '~/shared/constants/buzz.constants';
import {
  isPlacementSpendType,
  PLACEMENT_SPEND_TYPES,
} from '~/shared/constants/placement.constants';

// `PLACEMENT_SPEND_TYPES` is derived from `buzzPurchaseTypes`, which keys off a
// `purchasable` UX flag. That flag coinciding with "paid Buzz" is what makes the
// derivation correct today, and nothing about the flag's own meaning protects it
// — so the meaning is pinned here rather than in the derivation.
//
// Mutation-checked: flipping `purchasable: true` onto blue in
// `buzz.constants.ts` fails the first two cases below.
describe('placement currency', () => {
  it('excludes Blue Buzz', () => {
    expect(PLACEMENT_SPEND_TYPES).not.toContain('blue');
    expect(isPlacementSpendType('blue')).toBe(false);
  });

  it('is exactly the paid, spendable Buzz types', () => {
    expect([...PLACEMENT_SPEND_TYPES].sort()).toEqual(['green', 'yellow']);
  });

  it('stays in step with what the platform sells', () => {
    expect([...PLACEMENT_SPEND_TYPES].sort()).toEqual([...buzzPurchaseTypes].sort());
  });

  it('rejects anything that is not a placement currency', () => {
    expect(isPlacementSpendType('yellow')).toBe(true);
    expect(isPlacementSpendType('green')).toBe(true);
    expect(isPlacementSpendType('red')).toBe(false);
    expect(isPlacementSpendType('cashSettled')).toBe(false);
    expect(isPlacementSpendType('')).toBe(false);
  });
});

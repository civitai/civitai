import { describe, expect, it } from 'vitest';
import { submissionFeeLabel } from '~/components/CreatorShop/creator-shop.constants';

describe('submissionFeeLabel', () => {
  it('names the amount the item actually paid', () => {
    expect(submissionFeeLabel(10000)).toBe('10,000 · Paid');
    expect(submissionFeeLabel(5000)).toBe('5,000 · Paid');
  });

  // Fees are operator-tunable, so an item submitted before the amount was recorded
  // must show no number: today's configured fee is one nobody was charged.
  it('shows no number for an item with no recorded fee', () => {
    expect(submissionFeeLabel(undefined)).toBe('Paid');
    expect(submissionFeeLabel(undefined)).not.toMatch(/\d/);
  });
});

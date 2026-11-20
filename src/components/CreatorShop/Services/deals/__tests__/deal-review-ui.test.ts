import { describe, expect, it } from 'vitest';
import {
  reviewEditable,
  reviewPaymentLine,
} from '~/components/CreatorShop/Services/deals/deal-review-ui';

const review = (over: Record<string, unknown> = {}) =>
  ({
    verdict: 'Happy',
    hidden: false,
    editableUntil: new Date(Date.now() + 60_000),
    ...over,
  } as never);

describe('the review card', () => {
  it('offers an edit only inside the window on a review not hidden', () => {
    expect(reviewEditable(review())).toBe(true);
    expect(reviewEditable(review({ editableUntil: new Date(Date.now() - 1) }))).toBe(false);
    expect(reviewEditable(review({ hidden: true }))).toBe(false);
  });

  it('says nothing about payment before a happy review', () => {
    const state = (r: unknown) => ({ settled: false, finalsClear: true, review: r } as never);
    expect(reviewPaymentLine(state(review({ verdict: 'NotQuite' })), 'ana', 'buyer')).toBeNull();
    expect(reviewPaymentLine(state(null), 'ana', 'buyer')).toBeNull();
    expect(reviewPaymentLine(state(review()), 'ana', 'buyer')).not.toBeNull();
  });
});

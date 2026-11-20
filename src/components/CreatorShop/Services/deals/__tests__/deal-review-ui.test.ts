import { describe, expect, it } from 'vitest';
import {
  reviewEditable,
  reviewPaymentLine,
  reviewStatusLine,
} from '~/components/CreatorShop/Services/deals/deal-review-ui';

const review = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    verdict: 'Happy',
    comment: null,
    scanStatus: 'Scanned',
    published: true,
    editableUntil: new Date(Date.now() + 60_000),
    sellerReply: null,
    sellerReplyScanStatus: null,
    hidden: false,
    images: [],
    ...over,
  } as never);
const state = (over: Record<string, unknown> = {}, r = review()) =>
  ({ settled: false, finalsClear: true, review: r, ...over } as never);

describe('the review card copy', () => {
  it('says the seller is being paid after a happy review, or why not yet', () => {
    expect(reviewPaymentLine(state(), 'ana', 'buyer')).toBe('Paying ana.');
    expect(reviewPaymentLine(state({ finalsClear: false }), 'ana', 'buyer')).toBe(
      'The payment to ana waits on a file check.'
    );
    expect(reviewPaymentLine(state({ settled: true }), 'ana', 'seller')).toBe(
      'You have been paid.'
    );
    expect(
      reviewPaymentLine(state({}, review({ verdict: 'NotQuite' })), 'ana', 'buyer')
    ).toBeNull();
  });

  it('tells the buyer whether their review shows, and why not', () => {
    expect(reviewStatusLine(review(), false)).toBe('Your review is public, with your username.');
    expect(reviewStatusLine(review({ scanStatus: 'Pending', published: false }), false)).toMatch(
      /checking/
    );
    expect(reviewStatusLine(review({ scanStatus: 'Blocked', published: false }), false)).toMatch(
      /didn't pass/
    );
    expect(reviewStatusLine(review({ hidden: true, published: false }), false)).toMatch(/hid/);
    expect(reviewStatusLine(review({ verdict: 'NotQuite', published: false }), false)).toMatch(
      /once the payment is settled/
    );
  });

  it('offers an edit only inside the window on a review not hidden', () => {
    expect(reviewEditable(review())).toBe(true);
    expect(reviewEditable(review({ editableUntil: new Date(Date.now() - 1) }))).toBe(false);
    expect(reviewEditable(review({ hidden: true }))).toBe(false);
  });
});

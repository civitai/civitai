import type { ServiceDealView } from '~/components/CreatorShop/Services/deals/deal.util';

type DealReview = NonNullable<ServiceDealView['review']>;
type Review = NonNullable<DealReview['review']>;

/** Where the payout of a happy review stands, for either party. Null before a happy review. */
export function reviewPaymentLine(
  state: DealReview,
  seller: string,
  viewer: 'buyer' | 'seller' | 'moderator'
) {
  if (state.review?.verdict !== 'Happy') return null;
  if (state.settled)
    return viewer === 'seller' ? 'You have been paid.' : `${seller} has been paid.`;
  if (!state.finalsClear)
    return viewer === 'seller'
      ? 'The payment waits on a file check.'
      : `The payment to ${seller} waits on a file check.`;
  return viewer === 'seller' ? 'Paying you now.' : `Paying ${seller}.`;
}

/** Whether the buyer's review shows, and if not, why, as the buyer reads it. */
export function reviewStatusLine(review: Review, settled: boolean) {
  if (review.hidden) return 'A moderator hid your review.';
  if (review.scanStatus === 'Blocked')
    return "Your review isn't shown: it didn't pass our content check.";
  if (review.scanStatus !== 'Scanned') return "We're checking your review before it's shown.";
  if (review.published) return 'Your review is public, with your username.';
  if (review.verdict === 'NotQuite' && !settled)
    return 'Your review is shown once the payment is settled.';
  return 'Your review is shown once the file check clears.';
}

/** The buyer may still edit their comment. */
export const reviewEditable = (review: Review, now = new Date()) =>
  !review.hidden && !!review.editableUntil && new Date(review.editableUntil) > now;

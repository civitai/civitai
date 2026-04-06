/**
 * Gift card related copy/messaging constants.
 * Update these strings to change disclaimer text across all gift card pages.
 */

export const GIFT_CARD_DISCLAIMER = {
  /** Short notice shown on redemption forms */
  redemption:
    'By redeeming a code, you acknowledge that all redemptions are final and non-refundable.',

  /** Full disclaimer shown on gift cards purchase page */
  purchase:
    'All gift card purchases are final and non-refundable. Once a gift card code is redeemed, it cannot be reversed or refunded.',

  /** Link text for terms */
  termsLinkText: 'Buzz Terms',

  /** Terms page URL */
  termsUrl: '/content/buzz/terms',
} as const;

// Blue Buzz reward math for the Shopify merch store (shop.civitai.com).
// Pure + side-effect free so it can be unit-tested without a webhook payload.

// Base rate: 250 Blue Buzz per $1 of merch subtotal (= 25% of dollar value,
// since Buzz roughly maps 1000 Buzz = $1). Boostable per-coupon below.
export const MERCH_BLUE_BUZZ_PER_DOLLAR = 250;

// Coupon-code → reward multiplier. A code not listed here multiplies by 1.
// Promos that should pay out extra Blue Buzz go here (e.g. a launch 2x code).
// Codes are matched case-insensitively. Keep as a constant for now; promote to
// DB/Flipt later if marketing needs to change it without a deploy.
export const MERCH_BUZZ_COUPON_MULTIPLIERS: Record<string, number> = {
  // EXAMPLE2X: 2,
};

export function getCouponMultiplier(couponCodes: string[]): number {
  // Best (highest) multiplier among applied codes wins.
  return couponCodes.reduce((best, code) => {
    const mult = MERCH_BUZZ_COUPON_MULTIPLIERS[code.trim().toUpperCase()] ?? 1;
    return Math.max(best, mult);
  }, 1);
}

/**
 * Blue Buzz to grant for a merch order.
 * @param subtotal merch subtotal in dollars (excludes shipping/tax)
 * @param couponCodes discount codes applied to the order
 */
export function computeMerchBuzz(subtotal: number, couponCodes: string[] = []): number {
  if (!Number.isFinite(subtotal) || subtotal <= 0) return 0;
  const multiplier = getCouponMultiplier(couponCodes);
  return Math.floor(subtotal * MERCH_BLUE_BUZZ_PER_DOLLAR * multiplier);
}

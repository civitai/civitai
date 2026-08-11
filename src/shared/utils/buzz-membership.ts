import { buzzConstants, buzzSpendTypes } from '~/shared/constants/buzz.constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

/**
 * Buzz-purchased memberships carry a premium over the cash price: they hand out no
 * monthly Buzz, no purchase bonus and no Creator Program access, so the premium is what
 * keeps the cash membership the better deal.
 */
export const BUZZ_MEMBERSHIP_PREMIUM_MULTIPLIER = 1.25;

/**
 * Distinct `CustomerSubscription.buzzType` so a Buzz-purchased membership occupies its
 * own `@@unique([userId, buzzType])` slot instead of competing with the user's paid
 * yellow/green row. Same trick referral grants use (`buzzType = 'referral'`). Note this
 * column is a subscription-KIND discriminator here, not a Buzz colour. Neither is it the
 * currency paid: that is the calling domain's, resolved server-side at purchase time.
 */
export const BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE = 'buzzPurchase';

type MembershipStanding = {
  isBadState?: boolean;
  currentPeriodEnd: Date;
};

/**
 * Whether a subscription row still grants perks, and so blocks buying a perks-only
 * membership with Buzz. Shared with the client because the purchase page has to answer the
 * same question the purchase guard does, and a row's status alone doesn't answer it — a
 * lapsed row keeps `status = 'active'` until something reconciles it.
 */
export function isMembershipActive(subscription: MembershipStanding, now = new Date()) {
  return !subscription.isBadState && subscription.currentPeriodEnd > now;
}

type BuzzMembershipPriceInput = {
  /** Price amount in the smallest currency unit (cents), as stored on `Price.unitAmount`. */
  unitAmount: number;
  /** Explicit per-month Buzz price from product metadata; wins over the derived value. */
  buzzPrice?: number | null;
};

export function getBuzzMembershipPrice({ unitAmount, buzzPrice }: BuzzMembershipPriceInput) {
  if (buzzPrice && buzzPrice > 0) return Math.round(buzzPrice);

  const dollars = unitAmount / 100;
  return Math.round(dollars * buzzConstants.buzzDollarRatio * BUZZ_MEMBERSHIP_PREMIUM_MULTIPLIER);
}

/**
 * `CustomerSubscription.buzzType` is a currency for ordinary rows but a kind-discriminator
 * for others ('buzzPurchase', 'referral'), which have no colour of their own. Use this
 * anywhere the column feeds display, passing the current site's colour as the fallback.
 */
export function getSubscriptionDisplayBuzzType(
  subscriptionBuzzType: string | null | undefined,
  fallback: BuzzSpendType
): BuzzSpendType {
  return buzzSpendTypes.some((t) => t === subscriptionBuzzType)
    ? (subscriptionBuzzType as BuzzSpendType)
    : fallback;
}

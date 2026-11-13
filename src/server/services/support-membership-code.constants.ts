// Import-free on purpose: `consumeRedeemableCode` reads `isSupportCodeRedeemableBy`, and pulling the
// mint service (and its moderator.service graph) into the redemption path would cost every redeem.

export const SUPPORT_MEMBERSHIP_CODE_TIERS = ['bronze', 'silver', 'gold'] as const;
export type SupportMembershipCodeTier = (typeof SUPPORT_MEMBERSHIP_CODE_TIERS)[number];

export const SUPPORT_MEMBERSHIP_CODE_LIMITS = {
  maxMonths: 6,
  dailyPerModerator: 10,
  expiryDays: 30,
} as const;

/** Stored in `RedeemableCode.metadata.source`: changing it unbinds every outstanding support code. */
export const SUPPORT_MEMBERSHIP_CODE_SOURCE = 'moderator-membership-code';

/**
 * A support code is minted FOR one account and only that account may redeem it. Every other code
 * (shop, gifts, promotions) is redeemable by whoever holds it.
 */
export function isSupportCodeRedeemableBy(metadata: unknown, userId: number) {
  const meta = metadata as { source?: unknown; forUserId?: unknown } | null;
  if (meta?.source !== SUPPORT_MEMBERSHIP_CODE_SOURCE) return true;
  return meta.forUserId === userId;
}

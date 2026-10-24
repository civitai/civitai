// Shared by the panel, its form action and the service, and free of server imports so the panel can
// read it. These mirror `src/server/services/support-membership-code.constants.ts` in the main app,
// which is what enforces them: a drift here only makes the form offer or refuse the wrong values.

export const MEMBERSHIP_CODE_TIERS = ['bronze', 'silver', 'gold'] as const;
export type MembershipCodeTier = (typeof MEMBERSHIP_CODE_TIERS)[number];

export const MEMBERSHIP_CODE_TIER_LABELS: Record<MembershipCodeTier, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
};

export const MEMBERSHIP_CODE_MAX_MONTHS = 6;
export const MEMBERSHIP_CODE_EXPIRY_DAYS = 30;
export const MEMBERSHIP_CODE_DAILY_CAP = 10;

export type MintedMembershipCode = {
  code: string;
  expiresAt: string;
  tier: MembershipCodeTier;
  months: number;
};

/** `RedeemableCode.metadata.source` the main app stamps on support codes. */
export const SUPPORT_CODE_SOURCE = 'moderator-membership-code';

export type MembershipCodeStatus = 'open' | 'redeemed' | 'revoked' | 'expired';

/** Redeemed beats everything: a redeemed code cannot be revoked, and its expiry no longer matters. */
export function membershipCodeStatus(
  row: { redeemedAt: string | null; expiresAt: string | null; revokedAt: string | null },
  now = new Date()
): MembershipCodeStatus {
  if (row.redeemedAt) return 'redeemed';
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && new Date(row.expiresAt) <= now) return 'expired';
  return 'open';
}

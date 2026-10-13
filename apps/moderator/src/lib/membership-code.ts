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

export type MintedMembershipCode = {
  code: string;
  expiresAt: string;
  tier: MembershipCodeTier;
  months: number;
};

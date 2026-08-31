import type { CapTier } from '@civitai/buzz';

// Shape shared by the per-version sidebar editor and the bulk dialog. Mirrors the fields the
// setPaidAccess / bulkSetPaidAccess actions read off the form.
export type PaidAccessFormValue = {
  timeframe: number;
  permanent: boolean;
  accessPrice?: number;
  generationPrice?: number;
  freePreviewGenerations?: number;
  acceptsBlueBuzz: boolean;
  donationGoalEnabled: boolean;
  donationGoal?: number;
};

// Everything the form needs that isn't the value itself, pre-resolved by the caller.
export type PaidAccessContext = {
  canChooseTimed: boolean;
  canChoosePermanent: boolean;
  permBlocked: boolean;
  /** Why timed is unavailable, in the caller's own words — publish state for one version, a count for many. */
  timedBlockedReason?: string;
  /**
   * Why a PERMANENT gate is unavailable when the reason is the eligibility floor rather than the
   * allowance. The two are different refusals and only one of them is fixed by buying a membership.
   */
  permBlockedReason?: string;
  maxEarlyAccessDays: number;
  /** Prices applied this calendar month, and how many the tier allows (null = unlimited). */
  pricingUsed: number;
  pricingLimit: number | null;
  earlyAccessUsed: number;
  earlyAccessCap: number;
  tierLabel: string;
  capTier: CapTier;
  hadDonationGoal: boolean;
};

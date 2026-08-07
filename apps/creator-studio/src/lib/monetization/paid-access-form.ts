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
  maxEarlyAccessDays: number;
  permanentUsed: number;
  permanentCap: number | null;
  earlyAccessUsed: number;
  earlyAccessCap: number;
  tierLabel: string;
  capTier: CapTier;
  /** Null means uncapped — always the case for a timed window. Pass ctx.capTier for the creator's own. */
  accessCapFor: (tier: CapTier, permanent: boolean) => number | null;
  /**
   * The price already stored, so the max never clamps below it: the server blocks only RAISES, and
   * clamping down would silently cut a grandfathered price on an unrelated edit. Zero for bulk, which
   * has no single stored price to protect.
   */
  storedAccessPrice: number;
  hadDonationGoal: boolean;
};

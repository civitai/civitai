// The main app's `/api/mod/membership-gift/comp` payloads, as the gift panel reads them. The rules
// (who can receive one, the caps) live in the main app's membership-gift-comp.service only.

export const COMP_GIFT_TIERS = ['bronze', 'silver', 'gold'] as const;
export type CompGiftTier = (typeof COMP_GIFT_TIERS)[number];
/** Mirrors `COMP_GIFT_LIMITS.maxMonths` in the main app; the endpoint enforces it again. */
export const COMP_GIFT_MAX_MONTHS = 12;
/** Mirrors `COMP_GIFT_LIMITS.dailyPerModerator`, for the panel's wording only. */
export const COMP_GIFT_DAILY_LIMIT = 10;
export const COMP_GIFT_REASON_MIN = 10;

export type CompGiftability =
  | { status: 'no-subscription' }
  | { status: 'active'; tier: string; renewsAt: string; cancelsAtPeriodEnd: boolean }
  | { status: 'blocked'; reason: string };

export type CompGiftPreview = {
  outcome: 'would-comp';
  recipient: { id: number; username: string | null };
  tier: CompGiftTier;
  months: number;
  giftability: CompGiftability;
  compsInLast24h: number;
};

export type CompGiftResult = {
  outcome: 'comped';
  giftId: string;
  recipient: { id: number; username: string | null };
  tier: CompGiftTier;
  months: number;
  /** false: the gift exists but the recipient was not notified yet. */
  fulfilled: boolean;
};

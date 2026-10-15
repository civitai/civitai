import type { ServiceDealStatus } from '~/shared/utils/prisma/enums';

const HOUR = 3_600_000;

/** A request the seller has not answered by then expires, and the hold returns to the buyer. */
export const SERVICE_DEAL_ACCEPT_WINDOW_MS = 48 * HOUR;
/** How long past the due date before the buyer may cancel without the seller's agreement. */
export const SERVICE_DEAL_LATE_CANCEL_AFTER_MS = 24 * HOUR;
/** Unanswered cancellation requests are granted after this. */
export const SERVICE_DEAL_CANCELLATION_RESPONSE_MS = 48 * HOUR;
/** A delivery the buyer neither accepts nor sends back completes on its own after this. */
export const SERVICE_DEAL_AUTO_COMPLETE_MS = 72 * HOUR;
/** Between completion and payout, so a buyer can report final files that are missing or broken. */
export const SERVICE_DEAL_DISPUTE_WINDOW_MS = 48 * HOUR;

/**
 * When an unconfirmed hold is looked up. Longer than the Buzz call timeout, so a write that was
 * still in flight when the request gave up has landed (or failed) by then.
 */
export const SERVICE_DEAL_HOLD_RECONCILE_AFTER_MS = 10 * 60_000;
/**
 * How long a closed deal with an unconfirmed hold keeps being looked up, so a charge that lands
 * after the deal was cancelled is still found and returned.
 */
export const SERVICE_DEAL_HOLD_RECONCILE_LOOKBACK_MS = 7 * 24 * HOUR;

export const SERVICE_DEAL_OPEN_STATUSES = [
  'Requested',
  'Accepted',
  'Delivered',
  'InRevision',
  'CancellationRequested',
  'Disputed',
] as const satisfies readonly ServiceDealStatus[];

/** Closed with the Buzz going back to the buyer. */
export const SERVICE_DEAL_REFUND_STATUSES = [
  'Declined',
  'Expired',
  'Cancelled',
] as const satisfies readonly ServiceDealStatus[];

export type ServiceDealLegName = 'hold' | 'release' | 'fee' | 'refund';

/**
 * The Buzz external id of one leg. Derived from the deal and never time-based, so a retried leg
 * presents the same id and the Buzz service's dedupe is a real second line.
 */
export const serviceDealTransactionId = (dealId: number, leg: ServiceDealLegName) =>
  `creator-service-${dealId}-${leg}`;

/**
 * Why the system sent a deal to the moderators rather than paying it out. Moderation detail about
 * the other party or the files, so the parties never see it (see `dealVisibleReason`).
 */
export const SERVICE_DEAL_HOLD_REASONS = {
  sellerUnavailable: 'seller_unavailable',
  finalScanFailed: 'final_scan_failed',
} as const;

import { isSafeToRetry } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';

/**
 * Charging for a shop purchase whose external transaction id may have been used
 * before (a client resending its idempotency key).
 *
 * The ledger answers an external id it has already seen with a 200 whose legs
 * are marked `duplicate` (see the measured note in block-goods.service.ts). Such
 * a leg belongs to an earlier request, so this request neither grants, pays out
 * nor refunds. A 409 is handled the same way in case the separately deployed
 * ledger ever starts answering with one. Ordinary declines are 400s and pass
 * through as refusals.
 *
 * The outcome is reported as unknown, never as a refusal: a 4xx tells the client
 * nothing was charged and to retry with a fresh key.
 */

export const PURCHASE_STATE_UNKNOWN_MESSAGE =
  "We couldn't confirm this purchase. Check your cosmetics before trying again.";

/** The Axiom event name for a purchase that needs reconciling by hand. */
export const PURCHASE_STATE_UNKNOWN_LOG_NAME = 'shop-purchase-state-unknown';

export type ShopChargeContext = {
  userId: number;
  shopItemId: number;
  /** The charge's external transaction id prefix. */
  transactionId: string;
  amount: number;
};

/**
 * The purchase may or may not have been paid for, and nothing was granted. Each
 * one needs reconciling by hand (grant or refund), so it is logged as its own
 * event with everything needed to find the charge.
 */
export function purchaseStateUnknown(
  context: ShopChargeContext & { error?: unknown; refundError?: unknown },
  reason: string
) {
  const { error, refundError, ...ids } = context;
  logToAxiom({
    name: PURCHASE_STATE_UNKNOWN_LOG_NAME,
    type: 'error',
    message: 'shop purchase state unknown',
    reason,
    ...ids,
    error: error instanceof Error ? error.message : error,
    refundError: refundError instanceof Error ? refundError.message : refundError,
  });
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: PURCHASE_STATE_UNKNOWN_MESSAGE });
}

// The buzz client retries every failure by default, including ones where the
// first attempt may have landed. Its resend would then come back as this
// request's own duplicate. Only a failure that never reached the ledger is
// retried.
export const chargeRetryOptions = { shouldRetry: isSafeToRetry };

// A refund is sent once. The client may resend it only when the connection
// never opened (nothing reached the ledger); each attempt has a deadline, since
// a purchase request waits on this before it answers.
export const refundCallOptions = { retries: 1, shouldRetry: isSafeToRetry, timeoutMs: 10_000 };

type Charge = { transactionIds: { duplicate?: boolean }[]; transactionCount: number };

export async function chargeForShopPurchase<T extends Charge>(
  charge: () => Promise<T>,
  context: ShopChargeContext
): Promise<T> {
  let result: T;
  try {
    result = await charge();
  } catch (error) {
    if (getBuzzApiStatus(error) === 409)
      throw purchaseStateUnknown({ ...context, error }, 'ledger reported the id as taken');
    throw error;
  }
  // Any duplicate leg, not only all of them.
  if (result.transactionIds.some((leg) => leg.duplicate === true))
    throw purchaseStateUnknown(context, 'ledger returned duplicate legs');
  return result;
}

/**
 * Reverses this request's charge after a failed grant. Resolves only when the
 * ledger reports the whole amount back, so the caller may answer with a
 * refusal. Every other outcome (an error of any kind, a 409, a short or missing
 * total) is "state unknown": the refund is not resent from here, and the
 * purchase is left to reconciliation through the logged event.
 */
export async function refundShopCharge(
  refund: () => Promise<{ totalRefunded: number } | null | undefined>,
  context: ShopChargeContext & { error?: unknown }
) {
  let refunded: { totalRefunded: number } | null | undefined;
  try {
    refunded = await refund();
  } catch (refundError) {
    throw purchaseStateUnknown({ ...context, refundError }, 'refund failed');
  }
  // Not `<`: a missing total must never read as covered.
  if (!refunded || !(refunded.totalRefunded >= context.amount))
    throw purchaseStateUnknown(context, 'refund did not cover the charge');
}

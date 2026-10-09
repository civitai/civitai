import { isSafeToRetry } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import { withRetries } from '~/server/utils/errorHandling';

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

// Refunds are retried by refundShopCharge, briefly and a bounded number of
// times, so the client's own retry is off and each attempt has a deadline: a
// purchase request waits on this before it answers.
export const refundCallOptions = { retries: 0, timeoutMs: 10_000 };
const REFUND_ATTEMPTS = 3;
const REFUND_RETRY_DELAY_MS = 250;

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
 * Reverses this request's charge after a failed grant, retrying failures. A
 * refund is safe to resend: one the ledger already holds comes back as a 409,
 * which counts as refunded (as it does for the other refund callers). Resolves
 * only when the whole amount is known to be back, so the caller may answer with
 * a refusal; anything less is "state unknown".
 */
export async function refundShopCharge(
  refund: () => Promise<{ totalRefunded: number }>,
  context: ShopChargeContext & { error?: unknown }
) {
  let refunded: { totalRefunded: number } | 'already-refunded';
  try {
    refunded = await withRetries(
      () =>
        refund().catch((refundError: unknown) => {
          if (getBuzzApiStatus(refundError) === 409) return 'already-refunded' as const;
          throw refundError;
        }),
      REFUND_ATTEMPTS - 1,
      REFUND_RETRY_DELAY_MS
    );
  } catch (refundError) {
    throw purchaseStateUnknown({ ...context, refundError }, 'refund failed');
  }
  if (refunded === 'already-refunded') return;
  if (refunded.totalRefunded < context.amount)
    throw purchaseStateUnknown(context, 'refund did not cover the charge');
}

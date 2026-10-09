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

export function purchaseStateUnknown(context: Record<string, unknown>, reason: string) {
  logToAxiom({ level: 'error', message: `shop purchase state unknown: ${reason}`, data: context });
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: PURCHASE_STATE_UNKNOWN_MESSAGE });
}

// The buzz client retries every failure by default, including ones where the
// first attempt may have landed. Its resend would then come back as this
// request's own duplicate. Only a failure that never reached the ledger is
// retried.
export const chargeRetryOptions = { shouldRetry: isSafeToRetry };

type Charge = { transactionIds: { duplicate?: boolean }[]; transactionCount: number };

export async function chargeForShopPurchase<T extends Charge>(
  charge: () => Promise<T>,
  context: Record<string, unknown>
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

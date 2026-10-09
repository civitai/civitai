import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';

/**
 * Charging for a shop purchase when the external transaction id may have been
 * used before (a client resending its idempotency key, or two requests carrying
 * the same one).
 *
 * The ledger keys a charge on its external id prefix. A prefix it has already
 * seen comes back either as a 409 or as a 200 whose legs are marked `duplicate`
 * (which of the two is not settled), and in both cases THIS request moved no
 * Buzz. So neither may grant, pay anyone, or refund: a refund is prefix-wide and
 * would reverse the earlier request's charge.
 *
 * The outcome is reported as unknown, never as a refusal. A 4xx tells the client
 * nothing was charged and to retry with a fresh key, which is wrong here: the
 * earlier request with this key may well have charged.
 */

export const PURCHASE_STATE_UNKNOWN_MESSAGE =
  "We couldn't confirm this purchase. Check your cosmetics before trying again.";

export function purchaseStateUnknown(context: Record<string, unknown>, reason: string) {
  logToAxiom({ level: 'error', message: `shop purchase state unknown: ${reason}`, data: context });
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: PURCHASE_STATE_UNKNOWN_MESSAGE });
}

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
  // Mixed responses count too: some legs of this charge belong to an earlier
  // request, and nothing about the rest can be reversed without touching them.
  if (result.transactionIds.some((leg) => leg.duplicate === true))
    throw purchaseStateUnknown(context, 'ledger returned duplicate legs');
  return result;
}

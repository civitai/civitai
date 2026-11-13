import { writeMayHaveLanded } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import {
  createBuzzTransaction,
  getTransactionByExternalId,
  resendBuzzTransaction,
} from '~/server/services/buzz.service';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import { throwBadRequestError } from '~/server/utils/errorHandling';

/**
 * Charging a user once per action when a Buzz write can end with an unknown outcome.
 *
 * A write that times out, is reset, or answers 5xx may still have committed. Treated as "not
 * charged", the user retries, and a caller that minted a fresh external id per attempt charges
 * them again. So: the external id comes from the action (a key the client sends once and resends
 * on retry), and an unknown outcome is resolved by resending under that same id, never a new one.
 */

/** Told to the user when the charge may have happened and the flow did not finish. */
export const PAYMENT_OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether your Buzz payment went through. Trying this same action again from this page is safe. If you reloaded or left the page, check your Buzz balance and transactions first.";

/** Told to the user when the action's earlier charge was refunded: a new action is needed. */
export const PAYMENT_REFUNDED_MESSAGE =
  'The payment for this attempt was refunded. Please try again.';

/**
 * A 500, so a client holds its key (a 4xx tells it nothing was charged and to start over with a
 * new one). Logged with the external id so the charge can be found.
 */
export function paymentOutcomeUnknown(
  context: { externalTransactionId: string; userId: number; amount?: number },
  reason: string,
  errors: { error?: unknown; resendError?: unknown; lookupError?: unknown } = {}
) {
  const describe = (e: unknown) => (e instanceof Error ? e.message : e);
  logToAxiom({
    name: 'buzz-payment-outcome-unknown',
    type: 'error',
    message: 'buzz payment outcome unknown',
    reason,
    ...context,
    error: describe(errors.error),
    resendError: describe(errors.resendError),
    lookupError: describe(errors.lookupError),
  }).catch(() => undefined);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE });
}

/**
 * A failed charge that provably moved nothing: refused in the app before anything was sent (a
 * balance or validation refusal: a BAD_REQUEST with no ledger status behind it), or a failure the
 * buzz client's `writeMayHaveLanded` clears. Everything else is an unknown outcome.
 */
export function chargeWasDeclined(error: unknown): boolean {
  const refusedBeforeSending =
    error instanceof TRPCError &&
    error.code === 'BAD_REQUEST' &&
    getBuzzApiStatus(error) === undefined;
  return refusedBeforeSending || !writeMayHaveLanded(error);
}

type KeyedChargeInput = Parameters<typeof createBuzzTransaction>[0] & {
  toAccountId: number;
  externalTransactionId: string;
};

/**
 * Charges under `externalTransactionId`, once. Resolves with the ledger transaction id when the
 * ledger holds the charge, whether this call moved the money or an earlier attempt under the same
 * id did. A failure that provably moved nothing is rethrown. Any other failure is an unknown
 * outcome, resolved by resending the same write once (see `resendBuzzTransaction`: the ledger
 * answers an id it holds with that transaction's id and moves nothing). A resend that also fails,
 * or that the ledger answers with no transaction, is `PAYMENT_OUTCOME_UNKNOWN_MESSAGE`.
 *
 * `reusable`: the id may have been sent by an earlier request (it derives from a client key). The
 * ledger then answers 200 with whatever it holds under the id, including a charge a failed earlier
 * attempt refunded, so that is checked and refused with a 400: the client starts a new action
 * with a new key. An id minted for this call alone has no earlier charge to have been refunded.
 */
export async function chargeByExternalId(
  input: KeyedChargeInput,
  { reusable }: { reusable: boolean }
): Promise<{ transactionId: string }> {
  const context = {
    externalTransactionId: input.externalTransactionId,
    userId: input.fromAccountId,
    amount: input.amount,
  };

  let transactionId: string | null | undefined;
  try {
    ({ transactionId } = await createBuzzTransaction(input));
  } catch (error) {
    if (chargeWasDeclined(error)) throw error;
    try {
      const { insufficientFundsErrorMsg: _message, ...transaction } = input;
      ({ transactionId } = await resendBuzzTransaction(transaction));
    } catch (resendError) {
      throw paymentOutcomeUnknown(context, 'resend failed after unknown outcome', {
        error,
        resendError,
      });
    }
  }
  // A 200 with no id is the ledger's "insufficient funds" for an id it does not hold; after an
  // unknown outcome the first write may still be committing, so that is not "not charged" either.
  if (!transactionId) throw paymentOutcomeUnknown(context, 'ledger returned no transaction id');
  if (!reusable) return { transactionId };

  // A resend of an id the ledger holds answers 200 with that transaction, which may be one a
  // failed earlier attempt had refunded (the refund's id is the ledger's, `refund-<transactionId>`).
  let refund: unknown;
  try {
    refund = await getTransactionByExternalId(`refund-${transactionId}`);
  } catch (lookupError) {
    throw paymentOutcomeUnknown(context, 'refund lookup failed', { lookupError });
  }
  if (refund) throw throwBadRequestError(PAYMENT_REFUNDED_MESSAGE);

  return { transactionId };
}

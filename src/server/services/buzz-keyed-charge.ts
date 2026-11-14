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
import { refundExternalTransactionId } from '~/server/services/buzz-refund-id';

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

/** Told to a request whose key names a charge made for different terms. */
export const CHARGE_MISMATCH_MESSAGE =
  'This request does not match the earlier attempt with the same key. Please start again.';

/**
 * Whether the transaction the ledger holds under a reused id is the charge this request describes:
 * the same amount, payer and payee, and (where both sides name them) the same source account type
 * and transaction type. The ledger answers a held id with the transaction it holds whatever the
 * request sent, so without this a request reusing a key with other terms would carry on as if its
 * own charge had been made.
 */
export function heldChargeMatches(
  held: {
    amount?: unknown;
    fromAccountId?: unknown;
    toAccountId?: unknown;
    fromAccountType?: unknown;
    type?: unknown;
  },
  input: {
    amount: number;
    fromAccountId: number;
    toAccountId: number;
    fromAccountType?: string;
    type?: unknown;
  }
): boolean {
  if (Number(held.amount) !== input.amount) return false;
  if (Number(held.fromAccountId) !== input.fromAccountId) return false;
  if (Number(held.toAccountId) !== input.toAccountId) return false;
  if (
    input.fromAccountType !== undefined &&
    held.fromAccountType != null &&
    String(held.fromAccountType).toLowerCase() !== input.fromAccountType.toLowerCase()
  )
    return false;
  if (input.type !== undefined && held.type != null && Number(held.type) !== Number(input.type))
    return false;
  return true;
}

type KeyedChargeInput = Parameters<typeof createBuzzTransaction>[0] & {
  toAccountId: number;
  externalTransactionId: string;
};

/** The message for a charge the ledger declined for insufficient funds (no transaction back). */
export const CHARGE_DECLINED_MESSAGE = 'Unable to charge this payment';

/**
 * Charges under `externalTransactionId`, once. Resolves with the ledger transaction id when the
 * ledger holds the charge, whether this call moved the money or an earlier attempt under the same
 * id did.
 *
 * `reusable`: the id may have been sent by an earlier request (it derives from a client key).
 * - The id is looked up FIRST. Held, that is this action's charge: the flow continues from it
 *   without the app's balance pre-check, which would otherwise read the balance the charge already
 *   spent and refuse a retry whose money moved.
 * - The ledger answers a held id with whatever it holds, including a charge a failed earlier
 *   attempt refunded, so that is checked and refused with a 400: the client starts a new action
 *   with a new key.
 * - It also answers a held id whatever this request sent. However the id was reached (held
 *   before charging, a resend, or a first send another request beat), the held transaction is
 *   compared with this request (`heldChargeMatches`) and a mismatch is refused with a 400
 *   (`CHARGE_MISMATCH_MESSAGE`) before the caller records anything.
 *
 * Not held (or not reusable): charged. A failure that provably moved nothing is rethrown. Any other
 * failure is an unknown outcome, resolved by resending the same write once (see
 * `resendBuzzTransaction`). A resend that also fails, or that the ledger answers with no
 * transaction, is `PAYMENT_OUTCOME_UNKNOWN_MESSAGE`. A first send answered cleanly with no
 * transaction is the ledger's "insufficient funds": a 400, `declinedMessage`.
 */
export async function chargeByExternalId(
  input: KeyedChargeInput,
  {
    reusable,
    declinedMessage = CHARGE_DECLINED_MESSAGE,
  }: { reusable: boolean; declinedMessage?: string }
): Promise<{ transactionId: string }> {
  const context = {
    externalTransactionId: input.externalTransactionId,
    userId: input.fromAccountId,
    amount: input.amount,
  };
  const { insufficientFundsErrorMsg: _message, ...transaction } = input;

  // Resends the same write: the ledger answers a held id with its transaction, moving nothing.
  const resend = async (reason: string, error?: unknown) => {
    let resent: string | null | undefined;
    try {
      ({ transactionId: resent } = await resendBuzzTransaction(transaction));
    } catch (resendError) {
      throw paymentOutcomeUnknown(context, `resend failed: ${reason}`, { error, resendError });
    }
    // No id: the ledger holds nothing under it and the balance is short; after an unknown
    // outcome the first send may still be committing, so that is not "not charged" either.
    if (!resent) throw paymentOutcomeUnknown(context, `resend returned no transaction: ${reason}`);
    return resent;
  };

  type Held = Awaited<ReturnType<typeof getTransactionByExternalId>>;
  let transactionId: string | undefined;
  if (reusable) {
    let held: Held;
    try {
      held = await getTransactionByExternalId(input.externalTransactionId);
    } catch (lookupError) {
      throw paymentOutcomeUnknown(context, 'lookup before charging failed', { lookupError });
    }
    if (held) {
      if (!heldChargeMatches(held, input)) throw throwBadRequestError(CHARGE_MISMATCH_MESSAGE);
      transactionId = await resend('held before charging');
    }
  }
  const wasHeld = transactionId !== undefined;

  if (!transactionId) {
    let sent: { transactionId: string | null };
    try {
      sent = await createBuzzTransaction(input);
    } catch (error) {
      if (chargeWasDeclined(error)) throw error;
      sent = { transactionId: await resend('unknown outcome', error) };
    }
    if (!sent.transactionId) throw throwBadRequestError(declinedMessage);
    transactionId = sent.transactionId;
  }
  if (!reusable) return { transactionId };

  // A send (first or resend) under a reused id is answered with the held transaction if another
  // request under the key got there first, so what was charged is read back and compared.
  if (!wasHeld) {
    let charged: Held;
    try {
      charged = await getTransactionByExternalId(input.externalTransactionId);
    } catch (lookupError) {
      throw paymentOutcomeUnknown(context, 'lookup after charging failed', { lookupError });
    }
    if (!charged) throw paymentOutcomeUnknown(context, 'charge not found after charging');
    if (!heldChargeMatches(charged, input)) throw throwBadRequestError(CHARGE_MISMATCH_MESSAGE);
  }

  let refund: unknown;
  try {
    refund = await getTransactionByExternalId(refundExternalTransactionId(transactionId));
  } catch (lookupError) {
    throw paymentOutcomeUnknown(context, 'refund lookup failed', { lookupError });
  }
  if (refund) throw throwBadRequestError(PAYMENT_REFUNDED_MESSAGE);

  return { transactionId };
}

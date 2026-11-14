import type { BuzzReadOptions } from '@civitai/buzz';
import { writeMayHaveLanded } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import {
  createBuzzTransaction,
  getMultiAccountTransactionsByPrefix,
  getTransactionByExternalId,
  resendBuzzTransaction,
} from '~/server/services/buzz.service';
import { getPrefixRefundState } from '~/server/services/buzz-prefix-refund';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import type { TransactionType } from '~/shared/constants/buzz.constants';
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

  let transactionId: string | undefined;
  if (reusable) {
    let held: unknown;
    try {
      held = await getTransactionByExternalId(input.externalTransactionId);
    } catch (lookupError) {
      throw paymentOutcomeUnknown(context, 'lookup before charging failed', { lookupError });
    }
    if (held) transactionId = await resend('held before charging');
  }

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

  let refund: unknown;
  try {
    refund = await getTransactionByExternalId(refundExternalTransactionId(transactionId));
  } catch (lookupError) {
    throw paymentOutcomeUnknown(context, 'refund lookup failed', { lookupError });
  }
  if (refund) throw throwBadRequestError(PAYMENT_REFUNDED_MESSAGE);

  return { transactionId };
}

type PrefixChargeContext = { userId: number; amount?: number };

/**
 * Whether any leg under `prefix` has been refunded. A read that fails says nothing about it, so it
 * is "may have gone through". `opts` bounds the read (`CHARGE_LOCKED_READ` under the charge lock).
 */
export async function prefixWasRefunded(
  prefix: string,
  context: PrefixChargeContext,
  opts?: BuzzReadOptions
): Promise<boolean> {
  try {
    const { reversed } = await (opts
      ? getPrefixRefundState(prefix, opts)
      : getPrefixRefundState(prefix));
    return reversed.length > 0;
  } catch (lookupError) {
    throw paymentOutcomeUnknown(
      { externalTransactionId: prefix, ...context },
      'refund lookup failed',
      {
        lookupError,
      }
    );
  }
}

/** Told to the user when the action's key already holds a charge for a different payment. */
export const PAYMENT_KEY_REUSED_MESSAGE =
  'This payment was already started with different details. Please start it again.';

/** What a keyed prefix charge must have moved: checked against held legs before reusing them. */
export type ExpectedPrefixCharge = {
  amount: number;
  fromAccountId: number;
  fromAccountTypes: readonly string[];
  toAccountId: number;
  /** Compared only when the charge names one. */
  toAccountType?: string;
  type: TransactionType;
};

type HeldLeg = { externalTransactionId: string; amount: number };

/**
 * Legs the ledger already held under `prefix` are reused only when they are this request's charge.
 * The ledger answers a held id with what it holds and moves nothing, whatever was sent, so a key
 * resent with other content (another amount, currency or recipient) would otherwise be recorded at
 * the new request's terms on the old request's money. Each leg is read in full; together they must
 * total the amount, from and to the same accounts, of the same type. A mismatch is a 400 (nothing
 * was charged for THIS request, and the client starts over with a new key); a read that fails is
 * "may have gone through".
 */
async function assertHeldChargeMatches(
  prefix: string,
  context: PrefixChargeContext,
  expected: ExpectedPrefixCharge,
  listed?: HeldLeg[]
) {
  const outcomeContext = { externalTransactionId: prefix, ...context };
  let legs: HeldLeg[];
  let held: Awaited<ReturnType<typeof getTransactionByExternalId>>[];
  try {
    legs = listed ?? (await getMultiAccountTransactionsByPrefix(prefix));
    held = await Promise.all(
      legs.map((leg) => getTransactionByExternalId(leg.externalTransactionId))
    );
  } catch (lookupError) {
    throw paymentOutcomeUnknown(outcomeContext, 'held charge lookup failed', { lookupError });
  }
  if (!legs.length || held.some((leg) => !leg))
    throw paymentOutcomeUnknown(outcomeContext, 'held charge legs could not be read');

  const total = held.reduce((sum, leg) => sum + (leg?.amount ?? 0), 0);
  const matches =
    total === expected.amount &&
    held.every(
      (leg) =>
        !!leg &&
        leg.fromAccountId === expected.fromAccountId &&
        expected.fromAccountTypes.includes(leg.fromAccountType) &&
        leg.toAccountId === expected.toAccountId &&
        (expected.toAccountType === undefined || leg.toAccountType === expected.toAccountType) &&
        leg.type === expected.type
    );
  if (!matches) {
    logToAxiom({
      name: 'buzz-payment-key-reused',
      type: 'error',
      message: 'a keyed charge was resent with different details',
      ...outcomeContext,
    }).catch(() => undefined);
    throw new TRPCError({ code: 'BAD_REQUEST', message: PAYMENT_KEY_REUSED_MESSAGE });
  }
}

/**
 * The prefix twin of `chargeByExternalId`, for a charge made through the multi-account endpoint
 * (`charge`, which files its legs under `prefix`). Charges once per action when the prefix derives
 * from a client key. Resolves with `replayed`: true when the ledger already held this action's
 * legs, so an earlier request under the same key charged them.
 *
 * Every charge: a failure that provably moved nothing is `declined`. Any other failure is an
 * unknown outcome, resent once under the same prefix (the ledger answers a leg it holds as
 * `duplicate` and moves nothing); a resend that fails too is `PAYMENT_OUTCOME_UNKNOWN_MESSAGE`.
 *
 * `reusable` (the prefix derives from a client key, so an earlier request may have sent it):
 * - The prefix is looked up FIRST. The multi-account endpoint checks the total balance before it
 *   looks at ids, so a resend after a first charge that spent the balance is refused; held legs
 *   are this action's charge and the flow continues from them. `beforeCharging` (the app's own
 *   balance or eligibility checks) runs only when nothing is held, for the same reason.
 * - Held legs (found by the lookup, or answered `duplicate` by a send) are this request's charge
 *   only when they match `expected`: amount, accounts, account types and transaction type.
 *   Otherwise a 400 (`PAYMENT_KEY_REUSED_MESSAGE`), before anything is recorded.
 * - Held legs may have been refunded by an earlier request that failed to record them: refunded
 *   money is not a charge, so that is refused with a 400 and the client starts a new action.
 *
 * The caller records the charge under `withChargeKeyLock` (see `recordKeyedCharge`), which checks
 * the refund state again under the lock.
 */
export async function chargeByPrefix(
  prefix: string,
  context: PrefixChargeContext,
  {
    charge,
    reusable,
    expected,
    beforeCharging,
    declined,
  }: {
    charge: () => Promise<{ transactionIds?: { duplicate?: boolean | null }[] | null }>;
    reusable: boolean;
    /** What `charge` moves; held legs are reused only when they match it. */
    expected: ExpectedPrefixCharge;
    beforeCharging?: () => Promise<unknown>;
    declined: (error?: unknown) => Error;
  }
): Promise<{ replayed: boolean }> {
  const outcomeContext = { externalTransactionId: prefix, ...context };

  let replayed = false;
  let listed: HeldLeg[] | undefined;
  if (reusable) {
    try {
      listed = await getMultiAccountTransactionsByPrefix(prefix);
      replayed = listed.length > 0;
    } catch (lookupError) {
      throw paymentOutcomeUnknown(outcomeContext, 'lookup before charging failed', { lookupError });
    }
  }

  if (!replayed) {
    await beforeCharging?.();
    let sent: Awaited<ReturnType<typeof charge>>;
    try {
      sent = await charge();
    } catch (error) {
      if (chargeWasDeclined(error)) throw declined(error);
      try {
        sent = await charge();
      } catch (resendError) {
        throw paymentOutcomeUnknown(outcomeContext, 'resend failed after unknown outcome', {
          error,
          resendError,
        });
      }
    }
    if (!sent.transactionIds?.length) throw declined();
    replayed = sent.transactionIds.some((leg) => leg.duplicate === true);
    // A send answered `duplicate` reused legs this lookup did not see: list them again.
    listed = undefined;
  }

  if (reusable && replayed) await assertHeldChargeMatches(prefix, context, expected, listed);
  if (reusable && replayed && (await prefixWasRefunded(prefix, context)))
    throw throwBadRequestError(PAYMENT_REFUNDED_MESSAGE);
  return { replayed };
}

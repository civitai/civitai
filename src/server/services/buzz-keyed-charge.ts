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

/** Told to the user when the action's key already holds a charge for a different payment. */
export const PAYMENT_KEY_REUSED_MESSAGE =
  'This payment was already started with different details. Please start it again.';

/**
 * What a keyed charge must have moved, for both a single-id charge (`chargeByExternalId`) and a
 * prefix charge's legs (`chargeByPrefix`). The optional fields are compared only when named here
 * and present on the held transaction.
 */
export type ExpectedCharge = {
  amount: number;
  fromAccountId: number;
  /** A held leg's source account type must be one of these. */
  fromAccountTypes?: readonly string[];
  toAccountId: number;
  toAccountType?: string;
  type?: TransactionType;
};

/** A prefix charge always names its source account types and its transaction type. */
export type ExpectedPrefixCharge = ExpectedCharge & {
  fromAccountTypes: readonly string[];
  type: TransactionType;
};

type HeldTransaction = Awaited<ReturnType<typeof getTransactionByExternalId>>;
type HeldLeg = { externalTransactionId: string; amount: number };

/**
 * The one terms check for a reused key. The ledger answers a held id with what it holds and moves
 * nothing, whatever was sent, so a key resent with other content (another amount, currency or
 * recipient) would otherwise be recorded at the new request's terms on the old request's money.
 * Every held transaction must be readable; together they total the amount (unless `matchAmount`
 * is false, for a caller that charges less than it was asked for); each is from and to the same
 * accounts. The account types and the transaction type are compared only when both sides have
 * them: a read that leaves one out is not a different payment, and refusing it would refuse an
 * honest retry.
 */
export function heldChargeMatches(
  held: readonly HeldTransaction[],
  expected: ExpectedCharge,
  { matchAmount = true }: { matchAmount?: boolean } = {}
): boolean {
  if (!held.length || held.some((leg) => !leg)) return false;
  const total = held.reduce((sum, leg) => sum + (leg?.amount ?? 0), 0);
  if (matchAmount && total !== expected.amount) return false;
  return held.every(
    (leg) =>
      !!leg &&
      leg.fromAccountId === expected.fromAccountId &&
      (expected.fromAccountTypes === undefined ||
        leg.fromAccountType == null ||
        expected.fromAccountTypes.includes(leg.fromAccountType)) &&
      leg.toAccountId === expected.toAccountId &&
      (expected.toAccountType === undefined ||
        leg.toAccountType == null ||
        leg.toAccountType === expected.toAccountType) &&
      (expected.type === undefined || leg.type == null || leg.type === expected.type)
  );
}

/** The refusal of a reused key with other terms: a 400 (nothing was charged for THIS request). */
function keyReused(outcomeContext: {
  externalTransactionId: string;
  userId: number;
  amount?: number;
}) {
  logToAxiom({
    name: 'buzz-payment-key-reused',
    type: 'error',
    message: 'a keyed charge was resent with different details',
    ...outcomeContext,
  }).catch(() => undefined);
  return new TRPCError({ code: 'BAD_REQUEST', message: PAYMENT_KEY_REUSED_MESSAGE });
}

/**
 * How many times, and how far apart, a keyed charge reads the ledger for something it expects to
 * be there before treating it as absent: a write the ledger committed can be missing from its
 * first read. Used after a refused send and for the read-back after a send.
 */
export const HELD_AFTER_REFUSAL_LOOKUPS = 3;
export const HELD_AFTER_REFUSAL_PAUSE_MS = 250;

/**
 * The one bounded not-found re-read: `read` until `found` says so, at most
 * `HELD_AFTER_REFUSAL_LOOKUPS` times, `HELD_AFTER_REFUSAL_PAUSE_MS` apart; the last read otherwise.
 * A read that fails says nothing, so it is "may have gone through" (the client keeps its key).
 * Holds no database transaction.
 */
async function readUntilFound<T>(
  read: () => Promise<T>,
  found: (value: T) => boolean,
  outcomeContext: { externalTransactionId: string; userId: number; amount?: number },
  reason: string
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let value: T;
    try {
      value = await read();
    } catch (lookupError) {
      throw paymentOutcomeUnknown(outcomeContext, `${reason} failed`, { lookupError });
    }
    if (found(value) || attempt >= HELD_AFTER_REFUSAL_LOOKUPS) return value;
    await new Promise((resolve) => setTimeout(resolve, HELD_AFTER_REFUSAL_PAUSE_MS));
  }
}

/** The ledger's transaction under `externalTransactionId` (bounded re-read); null if never found. */
export async function findChargeWithRetry(
  externalTransactionId: string,
  context: { userId: number; amount?: number },
  reason: string
): Promise<HeldTransaction> {
  return readUntilFound(
    () => getTransactionByExternalId(externalTransactionId),
    (transaction) => !!transaction,
    { externalTransactionId, ...context },
    reason
  );
}

/** Legs held under `prefix` (bounded re-read); empty if none appear. */
function heldAfterRefusal(
  prefix: string,
  outcomeContext: { externalTransactionId: string; userId: number; amount?: number }
): Promise<HeldLeg[]> {
  return readUntilFound(
    () => getMultiAccountTransactionsByPrefix(prefix),
    (legs) => legs.length > 0,
    outcomeContext,
    'lookup after a refused charge'
  );
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
 *   (`PAYMENT_KEY_REUSED_MESSAGE`) before the caller records anything.
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
    matchAmount = true,
  }: {
    reusable: boolean;
    declinedMessage?: string;
    /**
     * false: a held charge is this request's whatever its amount (payer, payee and types are still
     * compared). For a caller that charges less than it was asked for, so a retry resending the
     * asked amount still matches its own earlier charge.
     */
    matchAmount?: boolean;
  }
): Promise<{ transactionId: string }> {
  const context = {
    externalTransactionId: input.externalTransactionId,
    userId: input.fromAccountId,
    amount: input.amount,
  };
  const { insufficientFundsErrorMsg: _message, ...transaction } = input;
  const expected: ExpectedCharge = {
    amount: input.amount,
    fromAccountId: input.fromAccountId,
    fromAccountTypes: input.fromAccountType ? [input.fromAccountType] : undefined,
    toAccountId: input.toAccountId,
    type: input.type,
  };
  const matches = (held: HeldTransaction) => heldChargeMatches([held], expected, { matchAmount });

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
    let held: HeldTransaction;
    try {
      held = await getTransactionByExternalId(input.externalTransactionId);
    } catch (lookupError) {
      throw paymentOutcomeUnknown(context, 'lookup before charging failed', { lookupError });
    }
    if (held) {
      if (!matches(held)) throw keyReused(context);
      transactionId = await resend('held before charging');
    }
  }
  const wasHeld = transactionId !== undefined;

  // A send declined for funds under a reused id may be a retry whose earlier charge spent the
  // balance and committed after the lookup above missed it (the balance is checked before the id).
  // So the id is read again (with the read-back's retries) before the decline is final; found, it
  // is continued from as a held charge.
  let heldAfterDecline = false;
  const continueIfHeld = async () => {
    if (!reusable) return undefined;
    const held = await findChargeWithRetry(
      input.externalTransactionId,
      context,
      'lookup after a decline'
    );
    if (!held) return undefined;
    if (!matches(held)) throw keyReused(context);
    heldAfterDecline = true;
    return resend('held after a declined send');
  };

  if (!transactionId) {
    let sentId: string | null | undefined;
    try {
      ({ transactionId: sentId } = await createBuzzTransaction(input));
    } catch (error) {
      if (!chargeWasDeclined(error)) sentId = await resend('unknown outcome', error);
      else {
        sentId = await continueIfHeld();
        if (!sentId) throw error;
      }
    }
    if (!sentId) {
      sentId = await continueIfHeld();
      if (!sentId) throw throwBadRequestError(declinedMessage);
    }
    transactionId = sentId;
  }
  if (!reusable) return { transactionId };

  // A send (first or resend) under a reused id is answered with the held transaction if another
  // request under the key got there first, so what was charged is read back and compared.
  // The ledger read can lag its write, so a charge just made may read back as not found for a
  // moment: not found is read again after each delay before it is called unknown. An error is not.
  if (!wasHeld && !heldAfterDecline) {
    const charged = await findChargeWithRetry(
      input.externalTransactionId,
      context,
      'lookup after charging'
    );
    if (!charged) throw paymentOutcomeUnknown(context, 'charge not found after charging');
    if (!matches(charged)) throw keyReused(context);
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

/**
 * Legs the ledger already held under `prefix` are reused only when they are this request's charge
 * (`heldChargeMatches`). Each leg is read in full. A mismatch is a 400 (the client starts over with
 * a new key); a read that fails, or a leg that cannot be read, is "may have gone through".
 */
async function assertHeldChargeMatches(
  prefix: string,
  context: PrefixChargeContext,
  expected: ExpectedPrefixCharge,
  listed?: HeldLeg[]
) {
  const outcomeContext = { externalTransactionId: prefix, ...context };
  let legs: HeldLeg[];
  let held: HeldTransaction[];
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
  if (!heldChargeMatches(held, expected)) throw keyReused(outcomeContext);
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
 * - A refusal (`beforeCharging`, or the ledger declining the send) looks for held legs again, a
 *   few times apart: both balance checks run before ids are looked at, and the first lookup can
 *   miss a charge an earlier request committed. Held, it continues from them as below.
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
    // A refusal: `beforeCharging` failing, a send that provably moved nothing, or a clean answer
    // with no transaction (the ledger's "insufficient funds").
    let refusal: unknown;
    let sent: Awaited<ReturnType<typeof charge>> | undefined;
    try {
      await beforeCharging?.();
    } catch (error) {
      refusal = error;
    }
    if (refusal === undefined) {
      try {
        sent = await charge();
      } catch (error) {
        if (chargeWasDeclined(error)) refusal = declined(error);
        else
          try {
            sent = await charge();
          } catch (resendError) {
            throw paymentOutcomeUnknown(outcomeContext, 'resend failed after unknown outcome', {
              error,
              resendError,
            });
          }
      }
      if (refusal === undefined && !sent?.transactionIds?.length) refusal = declined();
    }

    if (refusal !== undefined) {
      // Both balance checks (the app's and the ledger's) run before anything looks at ids. With a
      // key, an earlier request's charge under it may have spent the balance while the lookup
      // above could not see it yet (the read can lag the write). Then the action is paid and
      // continues from that charge, rather than being refused and the client's key released.
      const held = reusable ? await heldAfterRefusal(prefix, outcomeContext) : [];
      if (!held.length) throw refusal;
      listed = held;
      replayed = true;
    } else {
      replayed = !!sent?.transactionIds?.some((leg) => leg.duplicate === true);
      // A send answered `duplicate` reused legs this lookup did not see: list them again.
      listed = undefined;
    }
  }

  if (reusable && replayed) await assertHeldChargeMatches(prefix, context, expected, listed);
  if (reusable && replayed && (await prefixWasRefunded(prefix, context)))
    throw throwBadRequestError(PAYMENT_REFUNDED_MESSAGE);
  return { replayed };
}

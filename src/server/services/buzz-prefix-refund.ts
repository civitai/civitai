import type { BuzzReadOptions } from '@civitai/buzz';
import type { RefundMultiAccountTransactionInput } from '~/server/schema/buzz.schema';
import {
  getMultiAccountTransactionsByPrefix,
  getTransactionByExternalId,
  refundMultiAccountTransaction,
  refundTransaction,
} from '~/server/services/buzz.service';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';

export type PrefixRefundResult = {
  /** Legs this call reversed, and the Buzz they returned. */
  refundedLegs: number;
  refundedAmount: number;
  /** Legs an earlier attempt had already reversed. */
  alreadyRefundedLegs: number;
};

/**
 * Reverses every transaction under `externalTransactionIdPrefix`, and throws unless each one ends
 * up with a refund. A prefix matching nothing returns zeros.
 *
 * The prefix refund is all-or-nothing: it answers 409 when ANY leg already has a refund and then
 * reverses none of the others. So a 409 is not "done": the legs are listed, and each one still
 * missing its `refund-<transactionId>` is reversed on its own.
 */
export async function refundAllLegsByPrefix(
  input: RefundMultiAccountTransactionInput
): Promise<PrefixRefundResult> {
  try {
    const { refundedTransactions } = await refundMultiAccountTransaction(input);
    return {
      refundedLegs: refundedTransactions.length,
      refundedAmount: refundedTransactions.reduce((total, leg) => total + leg.amount, 0),
      alreadyRefundedLegs: 0,
    };
  } catch (error) {
    const status = getBuzzApiStatus(error);
    if (status === 404) return { refundedLegs: 0, refundedAmount: 0, alreadyRefundedLegs: 0 };
    if (status !== 409) throw error;
  }
  return refundMissingLegs(input);
}

/**
 * Refunds one transaction, treating "already refunded" as done. A repeat refund answers 200 today
 * and 409 once Buzz stops pre-checking duplicate external ids; the client's own retry after a lost
 * response gets the same 409. A 409 counts as done only when `refund-<transactionId>` is on the
 * ledger, so any other conflict still throws.
 */
export async function refundTransactionOnce(
  transactionId: string,
  description?: string,
  details?: MixedObject
): Promise<{ transactionId: string }> {
  try {
    return await refundTransaction(transactionId, description, details);
  } catch (error) {
    if (!(await isConflictWithRefundOnLedger(error, transactionId))) throw error;
    return { transactionId };
  }
}

async function isConflictWithRefundOnLedger(error: unknown, transactionId: string) {
  if (getBuzzApiStatus(error) !== 409) return false;
  return !!(await getTransactionByExternalId(`refund-${transactionId}`));
}

type PrefixLeg = Awaited<ReturnType<typeof getMultiAccountTransactionsByPrefix>>[number];

export type PrefixRefundState = { reversed: PrefixLeg[]; missing: PrefixLeg[] };

/**
 * Read-only: splits the transactions under a prefix by whether each already has its refund.
 * `opts` bounds both reads; a caller holding a lock while it waits needs them to end.
 */
export async function getPrefixRefundState(
  externalTransactionIdPrefix: string,
  opts?: BuzzReadOptions
): Promise<PrefixRefundState> {
  // Without opts each call is exactly as before, so existing callers see no change.
  const state: PrefixRefundState = { reversed: [], missing: [] };
  const legs = opts
    ? await getMultiAccountTransactionsByPrefix(externalTransactionIdPrefix, opts)
    : await getMultiAccountTransactionsByPrefix(externalTransactionIdPrefix);
  for (const leg of legs) {
    const refundId = `refund-${leg.transactionId}`;
    const refund = opts
      ? await getTransactionByExternalId(refundId, opts)
      : await getTransactionByExternalId(refundId);
    (refund ? state.reversed : state.missing).push(leg);
  }
  return state;
}

async function refundMissingLegs({
  externalTransactionIdPrefix,
  description,
  details,
}: RefundMultiAccountTransactionInput): Promise<PrefixRefundResult> {
  const { reversed, missing } = await getPrefixRefundState(externalTransactionIdPrefix);
  const legCount = reversed.length + missing.length;
  if (legCount === 0)
    throw new Error(
      `Buzz refused the refund of ${externalTransactionIdPrefix} as a conflict but lists no transactions under it`
    );

  const result: PrefixRefundResult = {
    refundedLegs: 0,
    refundedAmount: 0,
    alreadyRefundedLegs: reversed.length,
  };
  const failures: string[] = [];
  for (const leg of missing) {
    try {
      await refundTransaction(leg.transactionId, description, details);
      result.refundedLegs++;
      result.refundedAmount += leg.amount;
    } catch (error) {
      // Another attempt reversed this leg between the lookup and the refund.
      if (await isConflictWithRefundOnLedger(error, leg.transactionId)) {
        result.alreadyRefundedLegs++;
        continue;
      }
      failures.push(
        `${leg.transactionId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (failures.length > 0)
    throw new Error(
      `Refund of ${externalTransactionIdPrefix} left ${
        failures.length
      } of ${legCount} transactions unreversed (${failures.join('; ')})`
    );
  return result;
}

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

type PrefixLeg = Awaited<ReturnType<typeof getMultiAccountTransactionsByPrefix>>[number];

export type PrefixRefundState = { reversed: PrefixLeg[]; missing: PrefixLeg[] };

/** Read-only: splits the transactions under a prefix by whether each already has its refund. */
export async function getPrefixRefundState(
  externalTransactionIdPrefix: string
): Promise<PrefixRefundState> {
  const state: PrefixRefundState = { reversed: [], missing: [] };
  for (const leg of await getMultiAccountTransactionsByPrefix(externalTransactionIdPrefix)) {
    const refund = await getTransactionByExternalId(`refund-${leg.transactionId}`);
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
      // Single-transaction refunds key on `refund-<transactionId>`, so a 409 here means another
      // attempt reversed this leg between the lookup and the refund.
      if (getBuzzApiStatus(error) === 409) {
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

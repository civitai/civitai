/**
 * Funding for user-created (entry-fee) challenges.
 *
 * Money is held in the platform account (id 0): the creator's optional initial prize and
 * every participant's entry fee are transferred INTO account 0, and winner payouts at
 * completion come back OUT of account 0. Because the pool only grows by what was actually
 * collected (net of the house cut), payouts are covered by collections — nothing is minted
 * net. Account 0 has NO balance floor, so a refund must reverse a REAL prior charge — never
 * issue a fresh credit, or that credit is minted Buzz.
 *
 * Charges use deterministic externalTransactionId values so re-charge attempts are idempotent.
 * Cancellation reverses those actual charges (never mints a fresh credit): entry fees via a
 * prefix refund over `challenge-entry-fee-${challengeId}-`, the initial prize by refunding the
 * `challenge-initial-prize-${challengeId}` charge.
 */
import { dbRead, dbWrite } from '~/server/db/client';
import {
  createBuzzTransaction,
  createBuzzTransactionMany,
  getTransactionByExternalId,
  refundMultiAccountTransaction,
  refundTransaction,
} from '~/server/services/buzz.service';
import { throwInsufficientFundsError } from '~/server/utils/errorHandling';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { getEntryPoolContribution } from '~/shared/constants/challenge.constants';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';

const log = createLogger('challenge-funding', 'yellow');

/** Escrow the creator's optional initial prize when a user challenge is created. Idempotent. */
export async function chargeInitialPrize({
  challengeId,
  userId,
  amount,
}: {
  challengeId: number;
  userId: number;
  amount: number;
}) {
  if (amount <= 0) return;
  await createBuzzTransaction({
    fromAccountId: userId,
    toAccountId: 0,
    type: TransactionType.Purchase,
    amount,
    description: 'Challenge initial prize pool',
    externalTransactionId: `challenge-initial-prize-${challengeId}`,
    details: { challengeId },
  });
  log(`Escrowed ${amount} buzz initial prize for challenge ${challengeId}`);
}

/**
 * Charge a participant the entry fee for each newly accepted entry and grow the prize pool
 * by the net (fee minus house cut). The per-image charge is idempotent per (challenge, image)
 * via its deterministic externalTransactionId. If the payer can't afford every image, the
 * charges that DID succeed on this call are reversed before we abort, so no Buzz is stranded.
 * Intended to run inside the entry-submission flow BEFORE the entry is committed.
 */
export async function chargeEntryFees({
  challengeId,
  userId,
  imageIds,
  entryFee,
}: {
  challengeId: number;
  userId: number;
  imageIds: number[];
  entryFee: number;
}) {
  if (entryFee <= 0 || imageIds.length === 0) return { charged: 0 };

  // createBuzzTransactionMany SILENTLY DROPS insufficient-funds results (it does not throw),
  // so we must reconcile: every entry must be either a new transaction or a benign idempotency
  // conflict (already paid). Any shortfall means the payer couldn't afford an entry — throw so
  // the caller aborts the submission and the unpaid entry is never committed/counted.
  const result = await createBuzzTransactionMany(
    imageIds.map((imageId) => ({
      fromAccountId: userId,
      toAccountId: 0,
      type: TransactionType.Purchase,
      amount: entryFee,
      description: 'Challenge entry fee',
      externalTransactionId: `challenge-entry-fee-${challengeId}-${imageId}`,
      details: { challengeId, imageId },
    }))
  );

  const settled = result.transactions.length + result.conflicts.length;
  if (settled < imageIds.length) {
    // Money DID move for the successful charges (result.transactions are their ids). The caller
    // will abort and delete the CollectionItems, so without this the Buzz is orphaned (no entry ⇒
    // never refunded on cancel). Reverse only THIS call's new charges (conflicts were prior, paid
    // entries — leave them) before aborting.
    for (const transactionId of result.transactions) {
      await refundTransaction(transactionId, 'Challenge entry — partial charge reversed');
    }
    throw throwInsufficientFundsError('You do not have enough Buzz to pay the entry fee.');
  }

  // Grow the pool only by entries charged for the FIRST time (conflicts were already counted
  // on the original charge), so re-validation of the same images can't inflate the pool.
  const poolDelta = getEntryPoolContribution(entryFee) * result.transactions.length;
  if (poolDelta > 0) {
    await dbWrite.challenge.update({
      where: { id: challengeId },
      data: { prizePool: { increment: poolDelta } },
    });
  }
  return { charged: result.transactions.length };
}

/**
 * Reverse the funds collected for a user-created challenge when it is cancelled/voided: only the
 * entry fees that were ACTUALLY charged, plus the creator's initial prize if one was charged.
 * Nothing is minted — each refund reverses a real prior charge, not a fresh credit.
 *
 * Re-runnable: entry fees are reversed by a single prefix refund over the actual
 * `challenge-entry-fee-${challengeId}-` charges, and the initial prize by refunding the actual
 * `challenge-initial-prize-${challengeId}` charge; the buzz refund endpoints do not re-reverse an
 * already-refunded transaction, and voidChallenge reaches here at most once (Active/Scheduled →
 * Cancelled). No-op for non-User challenges, entryFee <= 0, and challenges with no initial prize.
 */
export async function refundUserChallengeFunds(challengeId: number) {
  const challenge = await dbRead.challenge.findUnique({
    where: { id: challengeId },
    select: {
      source: true,
      basePrizePool: true,
      createdById: true,
      entryFee: true,
    },
  });
  if (!challenge || challenge.source !== ChallengeSource.User) return { refundedEntries: 0 };

  let refundedEntries = 0;
  if (challenge.entryFee > 0) {
    // The trailing `-` keeps this prefix from matching another challenge's fees (e.g. challenge 5's
    // `challenge-entry-fee-5-` never matches challenge 50's `challenge-entry-fee-50-...`).
    const { refundedTransactions } = await refundMultiAccountTransaction({
      externalTransactionIdPrefix: `challenge-entry-fee-${challengeId}-`,
      description: 'Challenge cancelled — entry fee refund',
      details: { challengeId },
    });
    refundedEntries = refundedTransactions.length;
  }

  if (challenge.basePrizePool > 0 && challenge.createdById != null) {
    const prizeExternalId = `challenge-initial-prize-${challengeId}`;
    const prizeCharge = await getTransactionByExternalId(prizeExternalId);
    if (prizeCharge) {
      await refundTransaction(prizeExternalId, 'Challenge cancelled — initial prize refund', {
        challengeId,
      });
    }
  }

  log(
    `Refunded ${refundedEntries} entry fees + initial prize for cancelled challenge ${challengeId}`
  );
  return { refundedEntries };
}

/**
 * Funding for user-created (entry-fee) challenges.
 *
 * Money is held in the platform account (id 0): the creator's optional initial prize and
 * every participant's entry fee are transferred INTO account 0, and winner payouts at
 * completion come back OUT of account 0. Because the pool only grows by what was actually
 * collected (net of the house cut), payouts are covered by collections — nothing is minted
 * net. On cancellation we refund every entry fee and the creator's initial prize.
 *
 * All transfers use deterministic externalTransactionId values so retries are idempotent.
 */
import { dbRead, dbWrite } from '~/server/db/client';
import { createBuzzTransaction, createBuzzTransactionMany } from '~/server/services/buzz.service';
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
 * by the net (fee minus house cut). Idempotent per (challenge, image). Intended to run inside
 * the entry-submission flow BEFORE the entry is committed — see wiring note in the epic.
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
 * Refund all collected entry fees + the creator's initial prize when a user challenge is
 * cancelled/voided. Idempotent (deterministic refund ids). No-op for non-user challenges.
 */
export async function refundUserChallengeFunds(challengeId: number) {
  const challenge = await dbRead.challenge.findUnique({
    where: { id: challengeId },
    select: {
      source: true,
      basePrizePool: true,
      createdById: true,
      collectionId: true,
      entryFee: true,
    },
  });
  if (!challenge || challenge.source !== ChallengeSource.User) return { refundedEntries: 0 };

  let refundedEntries = 0;
  if (challenge.collectionId && challenge.entryFee > 0) {
    const entries = await dbRead.$queryRaw<{ imageId: number; addedById: number }[]>`
      SELECT "imageId", "addedById"
      FROM "CollectionItem"
      WHERE "collectionId" = ${challenge.collectionId}
        AND "imageId" IS NOT NULL
        AND "addedById" IS NOT NULL
    `;
    if (entries.length > 0) {
      await createBuzzTransactionMany(
        entries.map((e) => ({
          fromAccountId: 0,
          toAccountId: e.addedById,
          type: TransactionType.Refund,
          amount: challenge.entryFee,
          description: 'Challenge cancelled — entry fee refund',
          externalTransactionId: `challenge-entry-refund-${challengeId}-${e.imageId}`,
          details: { challengeId, imageId: e.imageId },
        }))
      );
      refundedEntries = entries.length;
    }
  }

  if (challenge.basePrizePool > 0 && challenge.createdById != null) {
    await createBuzzTransaction({
      fromAccountId: 0,
      toAccountId: challenge.createdById,
      type: TransactionType.Refund,
      amount: challenge.basePrizePool,
      description: 'Challenge cancelled — initial prize refund',
      externalTransactionId: `challenge-initial-refund-${challengeId}`,
      details: { challengeId },
    });
  }

  log(`Refunded ${refundedEntries} entry fees + initial prize for cancelled challenge ${challengeId}`);
  return { refundedEntries };
}

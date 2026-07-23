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
 * Each entry fee is charged as TWO transactions per (challenge, image):
 *   - house cut:  `challenge-entry-house-${challengeId}-${imageId}` — NEVER refunded
 *   - pool part:  `challenge-entry-fee-${challengeId}-${imageId}`  — refunded only on void
 * so voiding a challenge returns participants' pool contributions while the house keeps its
 * cut, without any amount math at refund time (the prefix refund can only see pool charges).
 *
 * Charges use deterministic externalTransactionId values so re-charge attempts are idempotent.
 * CRITICAL INVARIANT: an entry-fee charge is NEVER refunded outside of challenge cancellation.
 * The buzz ledger keeps a refunded transaction's externalTransactionId occupied (a retry gets
 * an idempotency `conflict` for it) and exposes no queryable refund state — so any refunded
 * leg would look "already paid" to a later retry and the entry would commit for free. Instead
 * of refunding on partial failure, we report exactly which images are fully paid and the
 * caller commits only those; a half-paid image self-heals on retry (the paid leg conflicts,
 * the missing leg is charged).
 *
 * Cancellation reverses the actual charges (never mints a fresh credit): pool parts via a
 * prefix refund over `challenge-entry-fee-${challengeId}-`, the initial prize via a prefix
 * refund over `challenge-initial-prize-${challengeId}-creator`. Both prefixes end in a
 * non-numeric token so one challenge's refund can't collide with another's (5 vs 50, 51, ...).
 */
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import type { ChallengeBuzzType } from '~/server/games/daily-challenge/challenge-currency';
import { logToAxiom } from '~/server/logging/client';
import {
  createBuzzTransaction,
  createBuzzTransactionMany,
  getTransactionByExternalId,
  refundMultiAccountTransaction,
} from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import {
  CHALLENGE_ENTRY_HOUSE_CUT,
  getEntryPoolContribution,
} from '~/shared/constants/challenge.constants';
import { ChallengeSource, CollectionItemStatus } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';

const log = createLogger('challenge-funding', 'yellow');

const houseFeeExternalId = (challengeId: number, imageId: number) =>
  `challenge-entry-house-${challengeId}-${imageId}`;
const poolFeeExternalId = (challengeId: number, imageId: number) =>
  `challenge-entry-fee-${challengeId}-${imageId}`;

/** Escrow the creator's optional initial prize when a user challenge is created. Idempotent. */
export async function chargeInitialPrize({
  challengeId,
  userId,
  amount,
  fromAccountType,
}: {
  challengeId: number;
  userId: number;
  amount: number;
  fromAccountType: ChallengeBuzzType;
}) {
  if (amount <= 0) return;
  await createBuzzTransaction({
    fromAccountId: userId,
    toAccountId: 0,
    fromAccountType,
    type: TransactionType.Purchase,
    amount,
    description: 'Challenge initial prize pool',
    // Trailing `-creator` keeps prefix matches unambiguous vs other challenge ids (challenge 5 would
    // otherwise prefix-match 50, 51, ...). The currency suffix scopes the id per wallet: a refunded
    // green charge leaves its id occupied in the ledger, so a later yellow re-charge on a shared id
    // would be silently dropped (createBuzzTransaction dedups on externalTransactionId) — leaving an
    // unfunded pool. `-creator` prefix matchers still match both `-creator-green` and `-creator-yellow`.
    externalTransactionId: `challenge-initial-prize-${challengeId}-creator-${fromAccountType}`,
    details: { challengeId },
  });
  log(`Escrowed ${amount} buzz initial prize for challenge ${challengeId}`);
}

export type ChargeEntryFeesResult = {
  /** Images whose house AND pool legs are both settled — safe to commit as entries. */
  paidImageIds: number[];
  /** Images with at least one leg missing — must NOT be committed. Retry self-heals. */
  unpaidImageIds: number[];
};

/**
 * Charge a participant the entry fee for each accepted entry and grow the prize pool by the
 * net (fee minus house cut). Each leg is idempotent per (challenge, image) via its
 * deterministic externalTransactionId.
 *
 * On a shortfall (insufficient funds mid-batch) nothing is refunded — see the header
 * invariant. Instead the per-image ledger state is verified and the result partitions the
 * images into fully-paid (commit them) and unpaid (reject them). A house-leg-only image is
 * reported unpaid; its house charge stays in account 0 (logged below) and completes into a
 * full payment if the user retries.
 *
 * Intended to run inside the entry-submission flow; callers commit ONLY `paidImageIds`.
 */
export async function chargeEntryFees({
  challengeId,
  userId,
  imageIds,
  entryFee,
  fromAccountType,
}: {
  challengeId: number;
  userId: number;
  imageIds: number[];
  entryFee: number;
  fromAccountType: ChallengeBuzzType;
}): Promise<ChargeEntryFeesResult> {
  if (entryFee <= 0 || imageIds.length === 0)
    return { paidImageIds: imageIds, unpaidImageIds: [] };

  const houseAmount = Math.min(entryFee, CHALLENGE_ENTRY_HOUSE_CUT);
  const poolAmount = entryFee - houseAmount;

  // House legs first: if the payer runs dry mid-submission the orphaned leg is the (small,
  // non-refundable anyway) house cut rather than the pool contribution.
  const houseResult = await createBuzzTransactionMany(
    imageIds.map((imageId) => ({
      fromAccountId: userId,
      toAccountId: 0,
      fromAccountType,
      type: TransactionType.Purchase,
      amount: houseAmount,
      description: 'Challenge entry fee (house)',
      externalTransactionId: houseFeeExternalId(challengeId, imageId),
      details: { challengeId, imageId },
    }))
  );
  const houseSettled = houseResult.transactions.length + houseResult.conflicts.length;

  // createBuzzTransactionMany SILENTLY DROPS insufficient-funds results (it does not throw)
  // and successes come back as opaque ids, so when the counts don't reconcile the only
  // reliable per-image source of truth is the ledger itself.
  const housePaidIds =
    houseSettled >= imageIds.length
      ? imageIds
      : await filterChargedImageIds(imageIds, (imageId) =>
          houseFeeExternalId(challengeId, imageId)
        );

  // Pool legs only for images whose house leg is settled, so a fully-dropped image never
  // ends up pool-only. entryFee <= house cut ⇒ no pool leg at all (fee is all house).
  let poolPaidIds = housePaidIds;
  let newPoolCharges = 0;
  if (poolAmount > 0 && housePaidIds.length > 0) {
    const poolResult = await createBuzzTransactionMany(
      housePaidIds.map((imageId) => ({
        fromAccountId: userId,
        toAccountId: 0,
        fromAccountType,
        type: TransactionType.Purchase,
        amount: poolAmount,
        description: 'Challenge entry fee (prize pool)',
        externalTransactionId: poolFeeExternalId(challengeId, imageId),
        details: { challengeId, imageId },
      }))
    );
    newPoolCharges = poolResult.transactions.length;
    const poolSettled = newPoolCharges + poolResult.conflicts.length;
    poolPaidIds =
      poolSettled >= housePaidIds.length
        ? housePaidIds
        : await filterChargedImageIds(housePaidIds, (imageId) =>
            poolFeeExternalId(challengeId, imageId)
          );
  }

  const paidImageIds = poolPaidIds;
  const paidSet = new Set(paidImageIds);
  const unpaidImageIds = imageIds.filter((id) => !paidSet.has(id));

  // Grow the pool only by pool legs charged for the FIRST time (conflicts were already counted
  // on the original charge), so re-validation of the same images can't inflate the pool. A pool
  // leg for an image the caller ends up not committing still backs the pool with real Buzz —
  // safe direction (never minted), and the void refund returns it.
  const poolDelta = getEntryPoolContribution(entryFee) * newPoolCharges;
  if (poolDelta > 0) {
    await dbWrite.challenge.update({
      where: { id: challengeId },
      data: { prizePool: { increment: poolDelta } },
    });
  }

  if (unpaidImageIds.length > 0) {
    const houseOrphans = paidSet.size < housePaidIds.length ? housePaidIds.filter((id) => !paidSet.has(id)) : [];
    logToAxiom({
      type: 'warning',
      name: 'challenge-entry-fee-partial-charge',
      message: 'Entry fee batch settled partially; unpaid images will not be committed',
      challengeId,
      userId,
      paidImageIds,
      unpaidImageIds,
      // House leg charged but pool leg dropped: 25 buzz sits in account 0 until the user
      // retries (completing the payment) or forever if they never do. Never refunded — see
      // the header invariant for why a refund here would enable free entries.
      houseOnlyImageIds: houseOrphans,
    }).catch(() => {});
  }

  return { paidImageIds, unpaidImageIds };
}

/** Ledger truth for "was this image's leg charged?" — survives crashes and unknown batch results. */
async function filterChargedImageIds(
  imageIds: number[],
  toExternalId: (imageId: number) => string
) {
  const charged: number[] = [];
  for (const imageId of imageIds) {
    const transaction = await getTransactionByExternalId(toExternalId(imageId));
    if (transaction != null) charged.push(imageId);
  }
  return charged;
}

/**
 * Reverse the funds collected for a user-created challenge when it is cancelled/voided: the
 * POOL portion of every entry fee that was actually charged, plus the creator's initial prize
 * if one was charged. House-cut legs (`challenge-entry-house-...`) are deliberately outside
 * the refunded prefix — the house cut is non-refundable. Nothing is minted — each refund
 * reverses a real prior charge, not a fresh credit.
 *
 * Re-runnable: pool legs are reversed by a single prefix refund over the actual
 * `challenge-entry-fee-${challengeId}-` charges, and the initial prize by a prefix refund over the
 * actual `challenge-initial-prize-${challengeId}-creator` charge; the buzz refund endpoints do not
 * re-reverse an already-refunded transaction. No-op for non-User challenges, entryFee <= 0, and
 * challenges with no initial prize.
 */
/**
 * Reverse one challenge-fund prefix, tolerating the buzz service's 404 (→ TRPCError NOT_FOUND)
 * when the prefix matches no transactions. A prefix matches nothing for an entryFee challenge that
 * never took a paid entry (e.g. a cancelled challenge with zero entries), or a prize that was never
 * actually charged — there is nothing to reverse, so that is a zero-refund no-op, not a failure
 * that should abort the surrounding void/delete. Returns the count of transactions reversed.
 */
async function refundChallengeFundsByPrefix(input: {
  externalTransactionIdPrefix: string;
  description: string;
  details: { challengeId: number };
}): Promise<number> {
  try {
    const { refundedTransactions } = await refundMultiAccountTransaction(input);
    return refundedTransactions.length;
  } catch (e) {
    if (e instanceof TRPCError && e.code === 'NOT_FOUND') return 0;
    throw e;
  }
}

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
    refundedEntries = await refundChallengeFundsByPrefix({
      externalTransactionIdPrefix: `challenge-entry-fee-${challengeId}-`,
      description: 'Challenge cancelled — entry fee refund',
      details: { challengeId },
    });
  }

  if (challenge.basePrizePool > 0 && challenge.createdById != null) {
    // Reverse the actual escrow charge by its collision-safe prefix (mint-safe) — the `-creator`
    // token makes this prefix unambiguous vs other challenge ids (5 vs 50, 51, ...).
    await refundChallengeFundsByPrefix({
      externalTransactionIdPrefix: `challenge-initial-prize-${challengeId}-creator`,
      description: 'Challenge cancelled — initial prize refund',
      details: { challengeId },
    });
  }

  log(
    `Refunded ${refundedEntries} entry-fee pool contributions + initial prize for cancelled challenge ${challengeId}`
  );
  return { refundedEntries };
}

/**
 * Alert when a completing user challenge holds less Buzz than its accepted entries imply. An
 * entry that reached the collection without a paid pool leg still competes for the prizes, so
 * the shortfall silently shrinks every winner's payout (challenge 413 completed with 2 entries
 * and a pool of 0, paying its winners nothing). Never throws — reporting only.
 */
export async function reportPoolFundingShortfall({
  challengeId,
  collectionId,
}: {
  challengeId: number;
  collectionId: number | null;
}) {
  if (!collectionId) return;

  const challenge = await dbRead.challenge.findUnique({
    where: { id: challengeId },
    select: { source: true, entryFee: true, basePrizePool: true, prizePool: true },
  });
  if (!challenge || challenge.source !== ChallengeSource.User || challenge.entryFee <= 0) return;

  const entryCount = await dbRead.collectionItem.count({
    where: { collectionId, status: CollectionItemStatus.ACCEPTED },
  });
  const expectedPool =
    challenge.basePrizePool + getEntryPoolContribution(challenge.entryFee) * entryCount;
  const shortfall = expectedPool - challenge.prizePool;
  if (shortfall <= 0) return;

  await logToAxiom({
    type: 'warning',
    name: 'challenge-pool-funding-shortfall',
    message: 'Challenge completing with a prize pool below what its accepted entries imply',
    challengeId,
    entryCount,
    entryFee: challenge.entryFee,
    prizePool: challenge.prizePool,
    expectedPool,
    shortfall,
  }).catch(() => {});
}

/** Build the winner-prize transactions for a challenge, paid in its stored currency. Pure. */
export function buildWinnerPayoutTransactions({
  challengeId,
  title,
  buzzType,
  winners,
}: {
  challengeId: number;
  title: string;
  buzzType: ChallengeBuzzType;
  winners: Array<{ userId: number; position: number; prize: number }>;
}) {
  return winners.map((entry) => ({
    type: TransactionType.Reward,
    toAccountId: entry.userId,
    fromAccountId: 0,
    amount: entry.prize,
    description: `Challenge Winner Prize #${entry.position}: ${title}`,
    externalTransactionId: `challenge-winner-prize-${challengeId}-${entry.userId}-place-${entry.position}`,
    toAccountType: buzzType,
  }));
}

/**
 * The stored pool currency for a challenge; falls back to yellow when the row is missing or holds
 * an unexpected value. NOTE: this is not a substitute for the migration — before the `buzzType`
 * column exists, the select itself throws. Apply the ALTER before deploying (see the migration).
 */
export async function getChallengeBuzzType(challengeId: number): Promise<ChallengeBuzzType> {
  const challenge = await dbRead.challenge.findUnique({
    where: { id: challengeId },
    select: { buzzType: true },
  });
  return challenge?.buzzType === 'green' ? 'green' : 'yellow';
}

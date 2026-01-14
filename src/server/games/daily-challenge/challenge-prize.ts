/**
 * Challenge Prize Distribution
 *
 * Handles awarding entry prizes to users who reach the threshold
 * during an active challenge.
 */

import { dbRead, dbWrite } from '~/server/db/client';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { BuzzSpendType, TransactionType } from '~/shared/constants/buzz.constants';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';

const log = createLogger('challenge-prize', 'yellow');

type ChallengeForPrize = {
  id: number;
  entryPrize: { buzz: number; points: number } | null;
  entryPrizeRequirement: number;
};

/**
 * Check if a user qualifies for entry prize and award it if so.
 * Called after a successful entry submission to a challenge collection.
 */
export async function checkAndAwardEntryPrize({
  userId,
  collectionId,
}: {
  userId: number;
  collectionId: number;
}): Promise<boolean> {
  try {
    // Find the active challenge for this collection
    const [challenge] = await dbRead.$queryRaw<ChallengeForPrize[]>`
      SELECT id, "entryPrize", "entryPrizeRequirement"
      FROM "Challenge"
      WHERE "collectionId" = ${collectionId}
      AND status = ${ChallengeStatus.Active}::"ChallengeStatus"
      LIMIT 1
    `;

    if (!challenge) {
      return false; // No active challenge for this collection
    }

    if (!challenge.entryPrize || challenge.entryPrize.buzz <= 0) {
      return false; // No entry prize configured
    }

    // Check if user already received entry prize for this challenge
    const [existing] = await dbRead.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count
      FROM "BuzzTransaction"
      WHERE "toUserId" = ${userId}
      AND type = ${TransactionType.Award}
      AND description LIKE ${'%challenge-entry-prize:' + challenge.id + '%'}
    `;

    if (Number(existing.count) > 0) {
      return false; // Already awarded
    }

    // Count user's accepted entries in this collection
    const [entryCount] = await dbRead.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count
      FROM "CollectionItem"
      WHERE "collectionId" = ${collectionId}
      AND "addedById" = ${userId}
      AND status IN ('ACCEPTED', 'REVIEW')
    `;

    const userEntryCount = Number(entryCount.count);

    if (userEntryCount < challenge.entryPrizeRequirement) {
      return false; // Hasn't reached threshold yet
    }

    // Award the entry prize
    await createBuzzTransaction({
      fromAccountId: 0, // System account
      toAccountId: userId,
      amount: challenge.entryPrize.buzz,
      type: TransactionType.Award,
      description: `Challenge participation prize (challenge-entry-prize:${challenge.id})`,
      details: {
        challengeId: challenge.id,
        entryCount: userEntryCount,
      },
    });

    log(`Awarded entry prize of ${challenge.entryPrize.buzz} buzz to user ${userId} for challenge ${challenge.id}`);

    return true;
  } catch (error) {
    log(`Error checking/awarding entry prize: ${error}`);
    return false;
  }
}

/**
 * Bulk check and award entry prizes for a batch of users.
 * Useful for processing after multiple entries are added.
 */
export async function checkAndAwardEntryPrizesBatch({
  userIds,
  collectionId,
}: {
  userIds: number[];
  collectionId: number;
}): Promise<number> {
  let awarded = 0;
  for (const userId of userIds) {
    const wasAwarded = await checkAndAwardEntryPrize({ userId, collectionId });
    if (wasAwarded) awarded++;
  }
  return awarded;
}

import { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { NotificationCategory } from '~/server/common/enums';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { createNotification } from '~/server/services/notification.service';
import { withRetries } from '~/utils/errorHandling';
import { getChallengeById } from '~/server/games/daily-challenge/challenge-helpers';
import { parseChallengeMetadata } from '~/server/schema/challenge.schema';
import {
  getJudgingConfig,
  type DailyChallengeDetails,
  type ChallengeConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { selectPayableUsers } from '~/server/games/daily-challenge/challenge-rewards.utils';
export { selectPayableUsers } from '~/server/games/daily-challenge/challenge-rewards.utils';

export async function promoteChallengeEntries(args: {
  collectionId: number;
  allowedNsfwLevel: number;
  modelVersionIds: number[];
  challengeDate: Date;
  reviewerId: number;
}): Promise<number> {
  const { collectionId, allowedNsfwLevel, modelVersionIds, challengeDate, reviewerId } = args;
  const hasModelVersionRestriction = modelVersionIds.length > 0;

  return dbWrite.$executeRaw`
    WITH source AS (
      SELECT
        i.id,
        (i."nsfwLevel" & ${allowedNsfwLevel}) > 0 as "isSafe",
        ${
          hasModelVersionRestriction
            ? Prisma.sql`EXISTS (SELECT 1 FROM "ImageResourceNew" ir WHERE ir."modelVersionId" = ANY(${modelVersionIds}) AND ir."imageId" = i.id)`
            : Prisma.sql`true`
        } as "hasResource",
        i."createdAt" >= ${challengeDate} as "isRecent"
      FROM "CollectionItem" ci
      JOIN "Image" i ON i.id = ci."imageId"
      WHERE ci."collectionId" = ${collectionId}
        AND ci.status = 'REVIEW'
        AND i."nsfwLevel" != 0
    )
    UPDATE "CollectionItem" ci SET
      status = CASE
        WHEN "isSafe" AND "hasResource" AND "isRecent" THEN 'ACCEPTED'::"CollectionItemStatus"
        ELSE 'REJECTED'::"CollectionItemStatus"
      END,
      "reviewedAt" = now(),
      "reviewedById" = ${reviewerId}
    FROM source s
    WHERE s.id = ci."imageId";
  `;
}

export async function distributeParticipationPrizes(args: {
  challengeId: number;
  collectionId: number;
  title: string;
  entryPrize: { buzz: number; points: number };
  entryPrizeRequirement: number;
  excludeUserIds: number[];
  notificationKey: string;
}): Promise<number[]> {
  const {
    challengeId,
    collectionId,
    title,
    entryPrize,
    entryPrizeRequirement,
    excludeUserIds,
    notificationKey,
  } = args;

  if (!entryPrize || entryPrize.buzz <= 0) return [];

  const earned = await dbRead.$queryRaw<{ userId: number }[]>`
    SELECT i."userId"
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE ci."collectionId" = ${collectionId}
      AND ci.status = 'ACCEPTED'
    GROUP BY i."userId"
    HAVING COUNT(*) >= ${entryPrizeRequirement}
  `;

  const payUserIds = selectPayableUsers(
    earned.map((e) => e.userId),
    excludeUserIds
  );
  if (payUserIds.length === 0) return [];

  await withRetries(() =>
    createBuzzTransactionMany(
      payUserIds.map((userId) => ({
        type: TransactionType.Reward,
        toAccountId: userId,
        fromAccountId: 0,
        amount: entryPrize.buzz,
        description: `Challenge Entry Prize: ${title}`,
        externalTransactionId: `challenge-entry-prize-${challengeId}-${userId}`,
        toAccountType: 'blue',
      }))
    )
  );

  await createNotification({
    type: 'challenge-participation',
    category: NotificationCategory.System,
    key: notificationKey,
    userIds: payUserIds,
    details: { challengeId, challengeName: title, prize: entryPrize.buzz },
  });

  return payUserIds;
}

export async function reconcileCompletedChallenge(
  challenge: DailyChallengeDetails,
  config: ChallengeConfig
): Promise<{ promoted: number; paid: number }> {
  const record = await getChallengeById(challenge.challengeId);
  const allowedNsfwLevel = record?.allowedNsfwLevel ?? 1;

  // Resolve judge — avoid importing from daily-challenge-processing.ts (circular dep)
  const judgeId = record?.judgeId ?? config.defaultJudgeId;
  if (!judgeId) throw new Error('No judge assigned and no defaultJudgeId configured');
  const judgingConfig = await getJudgingConfig(judgeId, record?.judgingPrompt);

  // 1. Promote any now-scanned REVIEW entries (skips nsfwLevel = 0)
  const promoted = await promoteChallengeEntries({
    collectionId: challenge.collectionId,
    allowedNsfwLevel,
    modelVersionIds: challenge.modelVersionIds,
    challengeDate: challenge.date,
    reviewerId: judgingConfig.userId,
  });

  // 2. Winners + already-paid are excluded from participation back-pay
  const winners = await dbRead.$queryRaw<{ userId: number }[]>`
    SELECT "userId" FROM "ChallengeWinner" WHERE "challengeId" = ${challenge.challengeId}
  `;
  const metadata = parseChallengeMetadata(record?.metadata);
  const alreadyPaid = metadata.reconciliation?.paidUserIds ?? [];
  const excludeUserIds = [...winners.map((w) => w.userId), ...alreadyPaid];

  // 3. Pay newly-eligible users (idempotent), hour-bucketed notification key
  const hourBucket = dayjs().utc().format('YYYY-MM-DD-HH');
  const paid = await distributeParticipationPrizes({
    challengeId: challenge.challengeId,
    collectionId: challenge.collectionId,
    title: challenge.title,
    entryPrize: challenge.entryPrize,
    entryPrizeRequirement: challenge.entryPrizeRequirement,
    excludeUserIds,
    notificationKey: `challenge-participation:${challenge.challengeId}:reconcile:${hourBucket}`,
  });

  // 4. Count remaining REVIEW items to determine if the queue has drained
  const remainingReview = await dbRead.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint as count FROM "CollectionItem"
    WHERE "collectionId" = ${challenge.collectionId} AND status = 'REVIEW'
  `;
  const done = Number(remainingReview[0]?.count ?? 0) === 0;

  // 5. Persist bookkeeping in challenge metadata
  await dbWrite.challenge.update({
    where: { id: challenge.challengeId },
    data: {
      metadata: {
        ...metadata,
        reconciliation: {
          ...(metadata.reconciliation ?? {}),
          paidUserIds: Array.from(new Set([...alreadyPaid, ...paid])),
          lastRunAt: new Date().toISOString(),
          done,
        },
      },
    },
  });

  return { promoted, paid: paid.length };
}

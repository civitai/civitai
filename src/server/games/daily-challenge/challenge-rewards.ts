import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { NotificationCategory } from '~/server/common/enums';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { createNotification } from '~/server/services/notification.service';
import { withRetries } from '~/utils/errorHandling';

export function selectPayableUsers(qualifierIds: number[], excludeUserIds: number[]): number[] {
  const exclude = new Set(excludeUserIds);
  const seen = new Set<number>();
  const result: number[] = [];
  for (const id of qualifierIds) {
    if (exclude.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

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

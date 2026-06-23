import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';

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

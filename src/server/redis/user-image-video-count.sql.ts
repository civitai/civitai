import { Prisma } from '@prisma/client';

/**
 * A user's countable images and videos, for the profile counts: scanned, not awaiting review, and on
 * a post that is published, public and not future-dated. `browsingLevelsFlag` narrows it to one
 * browsing-level variant.
 */
export function userImageVideoCountQuery(userIds: number[], browsingLevelsFlag?: number) {
  return Prisma.sql`
    SELECT
      "userId" as id,
      COALESCE(SUM(IIF("type" = 'image', 1, 0)), 0)::INT as "imageCount",
      COALESCE(SUM(IIF("type" = 'video', 1, 0)), 0)::INT as "videoCount"
    FROM "Image"
    WHERE "userId" IN (${Prisma.join(userIds)})
      AND "ingestion" = 'Scanned'
      AND "needsReview" IS NULL
      ${
        browsingLevelsFlag === undefined
          ? Prisma.empty
          : Prisma.sql`AND ("nsfwLevel" & ${browsingLevelsFlag}) != 0`
      }
      AND "postId" IS NOT NULL
      AND "postId" NOT IN (
        SELECT id
        FROM "Post"
        WHERE "userId" IN (${Prisma.join(userIds)})
          AND ("publishedAt" IS NULL OR availability = 'Private' OR "publishedAt" > NOW())
      )
    GROUP BY "userId"
  `;
}

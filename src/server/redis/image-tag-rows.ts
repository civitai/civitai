import type { PrismaClient } from '@prisma/client';
import type { TagSource } from '~/shared/utils/prisma/enums';

export type ImageTagRow = { imageId: number; source: TagSource; tagId: number };

/**
 * Binds the ids as ONE array parameter (`= ANY($1::int[])`), not Prisma's expanded `IN ($1…$n)`:
 * on Postgres 18 pg_stat_statements hashes a parameter that follows an IN-list by its position,
 * so an expanded list gets a separate query id per list length. Don't convert back to `findMany`.
 */
export async function getImageTagRows(
  db: Pick<PrismaClient, '$queryRaw'>,
  imageIds: number[]
): Promise<ImageTagRow[]> {
  if (!imageIds.length) return [];
  return db.$queryRaw<ImageTagRow[]>`
    SELECT "imageId", "source", "tagId"
    FROM "TagsOnImageDetails"
    WHERE "imageId" = ANY(${imageIds}::int[]) AND "disabled" = false
  `;
}

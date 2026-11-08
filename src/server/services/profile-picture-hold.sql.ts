import { Prisma } from '@prisma/client';
import { ownerHeldSql } from '~/server/services/legal-hold.service';

/**
 * Whether the owner (an int SQL expression) is told nothing about a removed profile picture: no
 * notice, no export row. Held, or named on any CsamReport as subject or secondary, open or closed.
 */
export function avatarRemovalUndisclosedSql(owner: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${ownerHeldSql(owner)} OR EXISTS (
    SELECT 1 FROM "CsamReport" c
    WHERE c."userId" = ${owner} OR c.details ->> 'secondaryUserId' = (${owner})::text
  ))`;
}

/** Whether the image (an SQL table alias) is Blocked or under any review. */
export function unservableImageSql(image: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${image}.ingestion = 'Blocked' OR ${image}."needsReview" IS NOT NULL)`;
}

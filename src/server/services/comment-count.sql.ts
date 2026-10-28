import { Prisma } from '@prisma/client';

/**
 * The top-level CommentV3 rows on an entity (`v` is their alias) that a shown comment count counts:
 * not deleted, nor hidden for ToS, which is also how an author's delete keeps one for a hold, so a
 * kept comment leaves the count as a deleted one does.
 */
export const countedTopLevelCommentSql = (v: Prisma.Sql, entityType: 'challenge' | 'review') =>
  Prisma.sql`${v}."entityType" = ${entityType}::"CommentEntityType" AND ${v}."parentId" IS NULL AND ${v}."deletedAt" IS NULL AND NOT ${v}."tosViolation"`;

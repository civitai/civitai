import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import { imageReviewedSql } from '~/server/common/image-visibility';
import { dbRead } from '~/server/db/client';
import { throwNotFoundError } from '~/server/utils/errorHandling';

/**
 * Who may fetch a single image by id, as SQL over `"Image" i` with `"Post" p` LEFT JOINed on
 * `i."postId"`. Moderators see everything. An image with a post needs it published and not
 * Private (or the viewer to own it). A postless image, with `postGates`:
 * - `'always'`: the owner's, the cover of a readable article, or an image of a viewable bounty.
 * - `'whenPosted'`: anyone's (`image.get` with `withoutPost`, for images shown outside a post).
 */
export function imageVisibilityConditions({
  userId,
  isModerator,
  postGates,
}: {
  userId?: number;
  isModerator?: boolean;
  postGates: 'always' | 'whenPosted';
}) {
  if (isModerator) return [];
  return [
    Prisma.sql`(
      i."needsReview" IS NULL AND ${imageReviewedSql()}
      -- A manager of the collection the image owner's own post was submitted to.
      OR p."collectionId" IS NOT NULL AND p."userId" = i."userId" AND EXISTS (
        SELECT 1 FROM "CollectionContributor" cc
        WHERE cc."collectionId" = p."collectionId"
          AND cc."userId" = ${userId}
          AND cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[]
      )
      OR i."userId" = ${userId}
    )`,
    // Post gates sit in the WHERE, not the JOIN: an image outlives a deleted post (`Image.postId`
    // is ON DELETE SET NULL) and an inner join drops it before ownership is tested. Nothing on
    // `Image` separates that from a never-posted upload, so a postless image is owner-only unless
    // it is the cover of an article the viewer could read (getArticleById's non-owner rule), or
    // shown on a bounty or bounty entry whose bounty the viewer could open (canViewBounty).
    Prisma.sql`(
      p."publishedAt" < now()
      OR p."userId" = ${userId}
      OR (i."postId" IS NULL AND ${
        postGates === 'whenPosted' ? Prisma.sql`TRUE` : Prisma.sql`i."userId" = ${userId}`
      })
      OR (i."postId" IS NULL AND EXISTS (
        SELECT 1 FROM "Article" a
        WHERE a."coverId" = i.id
          AND a.status = 'Published'
          AND a."publishedAt" IS NOT NULL
          AND a.ingestion = 'Scanned'
      ))
      OR (i."postId" IS NULL AND (
        EXISTS (
          SELECT 1 FROM "ImageConnection" ic
          JOIN "Bounty" b ON b.id = ic."entityId"
          WHERE ic."imageId" = i.id
            AND ic."entityType" = 'Bounty'
            AND (b.availability != 'Private' OR b."userId" = ${userId})
        )
        OR EXISTS (
          SELECT 1 FROM "ImageConnection" ic
          JOIN "BountyEntry" be ON be.id = ic."entityId"
          JOIN "Bounty" b ON b.id = be."bountyId"
          WHERE ic."imageId" = i.id
            AND ic."entityType" = 'BountyEntry'
            AND (b.availability != 'Private' OR b."userId" = ${userId})
        )
      ))
    )`,
    Prisma.sql`(i."postId" IS NULL OR p."availability" != 'Private' OR p."userId" = ${userId})`,
    // A Blocked-level rating is a ToS removal (or a pending-Blocked verdict awaiting
    // mod review) — never serve it by direct id to anyone but the owner. Feeds already
    // drop it via the browsingLevel mask; single-image fetch had no equivalent gate.
    Prisma.sql`(i."nsfwLevel" != ${NsfwLevel.Blocked} OR i."userId" = ${userId})`,
  ];
}

/**
 * The image's owner, rating and post, or NOT_FOUND unless the viewer may see its generation data:
 * `image.get`'s visibility conditions with its `withoutPost` rules (generation data is shown for
 * images outside a post too), plus its handler's owner block check.
 */
export async function assertImageVisibleToViewer({
  id,
  userId,
  isModerator,
}: {
  id: number;
  userId?: number;
  isModerator?: boolean;
}) {
  const [visible] = await dbRead.$queryRaw<
    { userId: number; nsfwLevel: number; postId: number | null }[]
  >`
    SELECT i."userId", i."nsfwLevel", i."postId"
    FROM "Image" i
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE ${Prisma.join(
      [
        Prisma.sql`i.id = ${id}`,
        ...imageVisibilityConditions({ userId, isModerator, postGates: 'whenPosted' }),
      ],
      ' AND '
    )}
  `;
  if (!visible) throw throwNotFoundError();
  if (userId && !isModerator) {
    // Imported here: user.service sits in the image.service import cycle.
    const { amIBlockedByUser } = await import('~/server/services/user.service');
    const blocked = await amIBlockedByUser({ userId, targetUserId: visible.userId });
    if (blocked) throw throwNotFoundError();
  }
  return visible;
}

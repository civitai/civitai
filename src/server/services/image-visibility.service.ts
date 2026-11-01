import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import { imageReviewedSql, minorMatureImageVisibleSql } from '~/server/common/image-visibility';
import { dbRead, dbWrite } from '~/server/db/client';
import { BlockedByUsers } from '~/server/services/user-preferences.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';

/**
 * Who may fetch a single image by id, as SQL over `"Image" i` with `"Post" p` LEFT JOINed on
 * `i."postId"`. Moderators see everything. An image with a post needs it published and not
 * Private (or the viewer to own it). A postless image needs the viewer to own it, or to be the
 * cover of a readable article, or an image of a viewable bounty.
 */
export function imageVisibilityConditions({
  userId,
  isModerator,
}: {
  userId?: number;
  isModerator?: boolean;
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
      OR (i."postId" IS NULL AND i."userId" = ${userId})
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
    minorMatureImageVisibleSql({ userId }),
  ];
}

/**
 * The image's owner, rating and post, or NOT_FOUND unless the viewer may see its generation data:
 * `image.get`'s visibility conditions plus its handler's owner block check.
 */
export async function assertImageVisibleToViewer({
  id,
  userId,
  isModerator,
  confirmBlockOnPrimary = false,
}: {
  id: number;
  userId?: number;
  isModerator?: boolean;
  /**
   * Only for a caller that WRITES on the strength of this check (the prompt-provenance mint):
   * confirm a cache "not blocked" against the primary. Read callers leave it off.
   */
  confirmBlockOnPrimary?: boolean;
}) {
  const [visible] = await dbRead.$queryRaw<
    { id: number; userId: number; nsfwLevel: number; postId: number | null }[]
  >`
    SELECT i.id, i."userId", i."nsfwLevel", i."postId"
    FROM "Image" i
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE ${Prisma.join(
      [Prisma.sql`i.id = ${id}`, ...imageVisibilityConditions({ userId, isModerator })],
      ' AND '
    )}
  `;
  if (!visible) throw throwNotFoundError();
  if (userId && !isModerator) {
    // Imported here: user.service sits in the image.service import cycle.
    const { amIBlockedByUser } = await import('~/server/services/user.service');
    const blocked = await amIBlockedByUser({
      userId,
      targetUserId: visible.userId,
      confirmOnPrimary: confirmBlockOnPrimary,
    });
    if (blocked) throw throwNotFoundError();
  }
  return visible;
}

/**
 * The subset of `ids` the viewer may open by id: `imageVisibilityConditions`, minus images whose
 * owner is on the viewer's `BlockedByUsers` list. Any id the replica doesn't return as visible is
 * read again from the primary, so an image or a publish from moments ago (a post published
 * straight into a collection) still counts.
 */
export async function getImageIdsVisibleToViewer({
  ids,
  userId,
  isModerator,
}: {
  ids: number[];
  userId?: number;
  isModerator?: boolean;
}): Promise<Set<number>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Set();

  const read = (db: typeof dbRead, idList: number[]) =>
    db.$queryRaw<{ id: number; userId: number }[]>`
      SELECT i.id, i."userId"
      FROM "Image" i
      LEFT JOIN "Post" p ON p.id = i."postId"
      WHERE ${Prisma.join(
        [
          Prisma.sql`i.id IN (${Prisma.join(idList)})`,
          ...imageVisibilityConditions({ userId, isModerator }),
        ],
        ' AND '
      )}
    `;

  const rows = await read(dbRead, wanted);
  const found = new Set(rows.map((r) => r.id));
  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length > 0) rows.push(...(await read(dbWrite, missing)));

  if (!userId || isModerator) return new Set(rows.map((r) => r.id));
  const optedOut = new Set((await BlockedByUsers.getCached({ userId })).map((u) => u.id));
  return new Set(
    rows.filter((r) => r.userId === userId || !optedOut.has(r.userId)).map((r) => r.id)
  );
}

/** NOT_FOUND unless the viewer may open every image in `ids` (see getImageIdsVisibleToViewer). */
export async function assertImagesVisibleToViewer(args: {
  ids: number[];
  userId?: number;
  isModerator?: boolean;
}) {
  const visible = await getImageIdsVisibleToViewer(args);
  if (args.ids.some((id) => !visible.has(id))) throw throwNotFoundError('Image not found');
}

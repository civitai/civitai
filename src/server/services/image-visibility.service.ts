import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import { imageReviewedSql } from '~/server/common/image-visibility';
import { dbRead } from '~/server/db/client';
import { amIBlockedByUser } from '~/server/services/user.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { isDefined } from '~/utils/type-guards';

/**
 * Who may fetch a single image by id, as SQL over `"Image" i` (and `"Post" p` LEFT JOINed on
 * `i."postId"` unless `postGates` is `'none'`). Moderators see everything.
 *
 * `postGates`:
 * - `'always'`: the post must be published and not Private; a postless image is the owner's only.
 * - `'none'`: no post checks (`image.get` with `withoutPost`, for images shown outside a post).
 * - `'whenPosted'`: post checks for an image that has a post, none for a postless one.
 */
export function imageVisibilityConditions({
  userId,
  isModerator,
  postGates,
}: {
  userId?: number;
  isModerator?: boolean;
  postGates: 'always' | 'none' | 'whenPosted';
}) {
  if (isModerator) return [];
  const AND: Prisma.Sql[] = [];
  AND.push(
    Prisma.sql`(${Prisma.join(
      [
        Prisma.sql`i."needsReview" IS NULL AND ${imageReviewedSql()}`,
        postGates === 'none'
          ? null
          : Prisma.sql`
              p."collectionId" IS NOT NULL AND EXISTS (
                SELECT 1 FROM "CollectionContributor" cc
                WHERE cc."collectionId" = p."collectionId"
                  AND cc."userId" = ${userId}
                  AND cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[]
              )`,
        Prisma.sql`i."userId" = ${userId}`,
      ].filter(isDefined),
      ' OR '
    )})`
  );

  if (postGates !== 'none') {
    // Post gates sit in the WHERE, not the JOIN: an image outlives a deleted post (`Image.postId`
    // is ON DELETE SET NULL) and an inner join drops it before ownership is tested. Nothing on
    // `Image` separates that from a never-posted upload, so a postless image is owner-only unless
    // it is the cover of an article the viewer could read (getArticleById's non-owner rule).
    AND.push(
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
        )`
    );
    AND.push(
      Prisma.sql`(i."postId" IS NULL OR p."availability" != 'Private' OR p."userId" = ${userId})`
    );
  }

  // A Blocked-level rating is a ToS removal (or a pending-Blocked verdict awaiting
  // mod review) — never serve it by direct id to anyone but the owner. Feeds already
  // drop it via the browsingLevel mask; single-image fetch had no equivalent gate.
  AND.push(Prisma.sql`(i."nsfwLevel" != ${NsfwLevel.Blocked} OR i."userId" = ${userId})`);
  return AND;
}

/**
 * Throws NOT_FOUND unless the viewer may see this image's generation data: `image.get`'s
 * visibility conditions plus its owner block check. Post checks apply whenever the image has a
 * post; a postless image follows `image.get`'s `withoutPost` rules, which is how images outside a
 * post (article covers, profile pictures) are viewed.
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
  const [visible] = await dbRead.$queryRaw<{ userId: number }[]>`
    SELECT i."userId"
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
    const blocked = await amIBlockedByUser({ userId, targetUserId: visible.userId });
    if (blocked) throw throwNotFoundError();
  }
}

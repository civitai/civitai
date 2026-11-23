import { Prisma } from '@prisma/client';
import { imageBlockedForConditions } from '~/server/common/image-visibility';

export { imageBlockedForConditions };
import { NsfwLevel } from '~/server/common/enums';
import {
  hasBlockMarkerSql,
  imageNotRestrictedSql,
  imageReviewedSql,
  minorMatureImageVisibleSql,
  notHeldForReviewSql,
} from '~/server/common/image-visibility';
import { dbRead, dbWrite } from '~/server/db/client';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { isPgInt4, queryPrismaSql } from '~/server/db/prisma-sql-kysely';
import { BlockedByUsers } from '~/server/services/user-preferences.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * The reviewed-only part of `getImagesForModelVersion`'s filter (its non-pending branch): not held
 * or minor-accepted, at a level in `browsingLevel`, and reviewed. Shared with `countableImageSql`
 * so a public image count and the gallery it counts cannot disagree.
 */
export const reviewedGalleryImageConditions = (
  browsingLevel: number = allBrowsingLevelsFlag
): Prisma.Sql[] => [
  Prisma.sql`i."needsReview" IS NULL AND i."acceptableMinor" = FALSE`,
  Prisma.sql`(i."nsfwLevel" & ${browsingLevel}) != 0`,
  imageReviewedSql(),
];

/**
 * What `getImagesForModelVersion` shows a signed-out viewer at some browsing level, over `"Image" i`:
 * its viewer-dependent terms (blocked-for, minor-mature, restricted base model) with no viewer.
 */
export const anonymousGalleryImageConditions = (): Prisma.Sql[] => [
  ...imageBlockedForConditions({}),
  ...reviewedGalleryImageConditions(),
  minorMatureImageVisibleSql({}),
  imageNotRestrictedSql(),
];

/**
 * The images a model's image count counts: the signed-out gallery's, less any ToS violation or
 * block marker the gallery's own terms do not already exclude.
 */
export const countableImageSql = () =>
  Prisma.sql`(${Prisma.join(
    [
      ...anonymousGalleryImageConditions(),
      Prisma.sql`NOT i."tosViolation"`,
      Prisma.sql`NOT ${hasBlockMarkerSql()}`,
    ],
    ' AND '
  )})`;

/**
 * Which images attached to an entity (a bounty, a bounty entry) a viewer is served, as SQL over
 * `"Image" i`. Held, unscanned, unrated, blocked, acceptable-minor and minor-restricted images are
 * the owner's and moderators' alone; base-model restricted images are the owner's alone.
 */
export function entityImageVisibilityConditions({
  userId,
  isModerator,
}: {
  userId?: number;
  isModerator?: boolean;
}): Prisma.Sql[] {
  const AND: Prisma.Sql[] = [];
  if (!isModerator) {
    AND.push(
      Prisma.sql`(i."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"${
        userId ? Prisma.sql` OR i."userId" = ${userId}` : Prisma.sql``
      })`,
      userId
        ? Prisma.sql`(i."nsfwLevel" NOT IN (0, ${NsfwLevel.Blocked}) OR i."userId" = ${userId})`
        : Prisma.sql`i."nsfwLevel" NOT IN (0, ${NsfwLevel.Blocked})`,
      userId
        ? Prisma.sql`(${Prisma.join(
            [Prisma.sql`i."needsReview" IS NULL`, Prisma.sql`i."userId" = ${userId}`],
            ' OR '
          )})`
        : Prisma.sql`(${Prisma.join([Prisma.sql`i."needsReview" IS NULL`], ' OR ')})`,
      userId
        ? Prisma.sql`(i."acceptableMinor" = FALSE OR i."userId" = ${userId})`
        : Prisma.sql`i."acceptableMinor" = FALSE`
    );
  }
  AND.push(...imageBlockedForConditions({ userId, isModerator }));
  AND.push(imageNotRestrictedSql({ viewerId: userId }));
  AND.push(minorMatureImageVisibleSql({ userId, isModerator }));
  return AND;
}

/**
 * Who may fetch a single image by id, as SQL over `"Image" i` with `"Post" p` LEFT JOINed on
 * `i."postId"`. Moderators see everything. An image with a post needs it published and not
 * Private (or the viewer to own it). A postless image needs the viewer to own it, or to be the
 * cover of a readable article, or an image of a viewable bounty.
 */
export function imageVisibilityConditions({
  userId,
  isModerator,
  ownerSeesHeld = false,
}: {
  userId?: number;
  isModerator?: boolean;
  /**
   * `userId` (the session user) also sees their own items under an owner-hidden review hold. Only
   * for a read that shows the owner their item; not for one that acts on the image (a remix, say).
   */
  ownerSeesHeld?: boolean;
}) {
  if (isModerator) return [];
  return [
    Prisma.sql`(
      i."needsReview" IS NULL AND ${imageReviewedSql()}
      -- A manager of the collection the image owner's own post was submitted to, once reviewed.
      OR p."collectionId" IS NOT NULL AND p."userId" = i."userId" AND ${imageReviewedSql()} AND EXISTS (
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
    // it is the cover or banner of an article the viewer could read (getArticleById's non-owner rule), or
    // shown on a bounty or bounty entry whose bounty the viewer could open (canViewBounty).
    Prisma.sql`(
      p."publishedAt" < now()
      OR p."userId" = ${userId}
      OR (i."postId" IS NULL AND i."userId" = ${userId})
      OR (i."postId" IS NULL AND EXISTS (
        SELECT 1 FROM "Article" a
        WHERE (a."coverId" = i.id OR a."bannerId" = i.id)
          AND a.status = 'Published'
          AND a."publishedAt" IS NOT NULL
          AND a.ingestion = 'Scanned'
          AND (a.availability != 'Private' OR a."userId" = ${userId})
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
    // An unrated image is its owner's and moderators' alone, as in the image feeds.
    Prisma.sql`(i."nsfwLevel" != 0 OR i."userId" = ${userId})`,
    // Owner-only, as in the image feeds (`pendingOthersImageConditions`).
    userId
      ? Prisma.sql`(i."acceptableMinor" = FALSE OR i."userId" = ${userId})`
      : Prisma.sql`(i."acceptableMinor" = FALSE)`,
    // Not to a collection manager; to the owner only where the caller asks.
    notHeldForReviewSql(ownerSeesHeld ? userId : undefined),
    minorMatureImageVisibleSql({ userId }),
    ...imageBlockedForConditions({ userId }),
    imageNotRestrictedSql({ viewerId: userId }),
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
  withSignedOutVerdict = false,
  ownerSeesHeld = false,
}: {
  id: number;
  userId?: number;
  isModerator?: boolean;
  /** `imageVisibilityConditions`' `ownerSeesHeld`. */
  ownerSeesHeld?: boolean;
  /**
   * Only for a caller that WRITES on the strength of this check (the prompt-provenance mint):
   * confirm a cache "not blocked" against the primary. Read callers leave it off.
   */
  confirmBlockOnPrimary?: boolean;
  /**
   * Also answer whether a signed-out viewer may open it (`visibleSignedOut`), from the same read,
   * for a caller deciding whether the response may go to a shared cache.
   */
  withSignedOutVerdict?: boolean;
}) {
  const signedOutVerdict = withSignedOutVerdict
    ? Prisma.sql`(${Prisma.join([Prisma.sql`TRUE`, ...imageVisibilityConditions({})], ' AND ')})`
    : Prisma.sql`NULL::boolean`;
  // Through Kysely over the pg pools, not Prisma's `$queryRaw`: one of the hottest single-image
  // reads, and the same statement and parameters either way (`queryPrismaSql`). Every column is
  // int4 or boolean, which both executors parse alike.
  // An id past int4 names no image: not found, as Prisma answered, rather than a range error.
  if (!isPgInt4(id)) throw throwNotFoundError();
  const { kyselyRead } = await loadKyselyDb();
  const [visible] = await queryPrismaSql<{
    id: number;
    userId: number;
    nsfwLevel: number;
    postId: number | null;
    visibleSignedOut: boolean | null;
  }>(
    kyselyRead,
    Prisma.sql`
    SELECT i.id, i."userId", i."nsfwLevel", i."postId", ${signedOutVerdict} AS "visibleSignedOut"
    FROM "Image" i
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE ${Prisma.join(
      [
        Prisma.sql`i.id = ${id}`,
        ...imageVisibilityConditions({ userId, isModerator, ownerSeesHeld }),
      ],
      ' AND '
    )}
  `
  );
  if (!visible) throw throwNotFoundError();
  if (userId && !isModerator) {
    // Imported here, but not a cycle cut: the cycle guards count dynamic imports (docs/dev/import-cycles.md).
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

type SongViewer = {
  user?: { id: number; isModerator?: boolean | null };
  features: { music?: boolean };
};

/**
 * The ids in `ids` the viewer may open; the one read every by-id song procedure goes through. Null
 * when the music flag is off.
 */
export async function getVisibleSongIds({
  ids,
  viewer,
}: {
  ids: number[];
  viewer: SongViewer;
}): Promise<Set<number> | null> {
  if (!viewer.features.music) return null;
  return getImageIdsVisibleToViewer({
    ids,
    userId: viewer.user?.id,
    isModerator: viewer.user?.isModerator ?? undefined,
  });
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

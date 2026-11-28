import { Prisma } from '@prisma/client';
import { imageBlockedForConditions } from '~/server/common/image-visibility';
import { reportListedImageSql } from '~/server/services/report-listed-visibility';

export { imageBlockedForConditions };
import { NsfwLevel } from '~/server/common/enums';
import {
  hasBlockMarkerSql,
  imageNotRestrictedSql,
  imageReviewedSql,
  minorMatureImageVisibleSql,
  notHeldForReviewSql,
  ownerMediaSql,
} from '~/server/common/image-visibility';
import { dbRead, dbWrite } from '~/server/db/client';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { isPgInt4, queryPrismaSql } from '~/server/db/prisma-sql-kysely';
import {
  notDealFileCopySql,
  notHeldReviewCopySql,
  notServerCopySql,
  shownReviewImageSql,
} from '~/server/services/creator-service-review-image-sql';
import { canSeeSongs, songsHiddenSql } from '~/server/services/song-visibility-sql';
import { BlockedByUsers, getBlockedPairIds } from '~/server/services/user-preferences.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

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
 * `"Image" i`. Held, unscanned, unrated, blocked, ToS-removed, acceptable-minor and
 * minor-restricted images are the owner's and moderators' alone; base-model restricted images are
 * the owner's alone. Images listed on a CsamReport are the uploader's (`ownerSeesReportListed`) and
 * `seesReportListed` viewers' alone, moderators included.
 */
export function entityImageVisibilityConditions({
  userId,
  isModerator,
  seesReportListed,
  ownerSeesReportListed = false,
}: {
  userId?: number;
  isModerator?: boolean;
  /** The held-media viewer (`seesReportListed(ctx)`); false for a read with no viewer. */
  seesReportListed: boolean;
  /** The request carries the owner's view (a session or a full-access key). */
  ownerSeesReportListed?: boolean;
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
        : Prisma.sql`i."acceptableMinor" = FALSE`,
      userId
        ? Prisma.sql`(i."tosViolation" IS NOT TRUE OR i."userId" = ${userId})`
        : Prisma.sql`i."tosViolation" IS NOT TRUE`
    );
  }
  AND.push(...imageBlockedForConditions({ userId, isModerator }));
  if (!isModerator) AND.push(ownerMediaSql(userId));
  AND.push(imageNotRestrictedSql({ viewerId: userId }));
  AND.push(minorMatureImageVisibleSql({ userId, isModerator }));
  AND.push(reportListedImageSql({ userId, seesReportListed, ownerSeesReportListed }));
  return AND;
}

export { reportListedImageSql };

/**
 * Who may fetch a single image by id, as SQL over `"Image" i` with `"Post" p` LEFT JOINed on
 * `i."postId"`. Moderators see everything. An image with a post needs it published and not
 * Private (or the viewer to own it). A postless image needs the viewer to own it, or to be the
 * cover of a readable article, or an image of a viewable bounty. A service review image opens only
 * where the caller opts in (`shownReviewImageLevels`).
 */
export function imageVisibilityConditions({
  userId,
  isModerator,
  ownerSeesHeld = false,
  shownReviewImageLevels,
  judgingCrucibleIds,
  music,
  ownerKeepsBlockedRow = false,
}: {
  userId?: number;
  isModerator?: boolean;
  /**
   * The viewer's `music` flag: `false` hides songs other than the viewer's own (`songsHiddenSql`).
   * Unset leaves songs to the caller, as for a by-id action a song procedure already gated.
   */
  music?: boolean;
  /**
   * The owner keeps a blocked image's row, for a read whose handler serves it without its media
   * (`viewerCanSeeImageMedia`) or returns no media at all. Never for a read that returns a url.
   */
  ownerKeepsBlockedRow?: boolean;
  /**
   * `userId` (the session user) also sees their own items under an owner-hidden review hold. Only
   * for a read that shows the owner their item; not for one that acts on the image (a remix, say).
   */
  ownerSeesHeld?: boolean;
  /**
   * Admit a service review image: to anyone while its review shows it at these levels (the
   * request's, never the client's), and to its uploader. Only the image page's read and the report
   * check pass it; every other by-id use of an image (collect, react, comment, remix, generation
   * data) must not.
   */
  shownReviewImageLevels?: number;
  /**
   * Crucibles the viewer is judging (`getJudgingCrucibleIdsForImage`): their entries open while
   * the entry's post waits to publish at the crucible's end. Only the reaction toggle passes it, and
   * only that helper's answer: these ids are trusted, never take them from input.
   */
  judgingCrucibleIds?: number[];
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
      ${
        judgingCrucibleIds?.length
          ? Prisma.sql`OR (p."publishedAt" IS NOT NULL AND EXISTS (
              SELECT 1 FROM "CrucibleEntry" ce
              WHERE ce."imageId" = i.id AND ce."crucibleId" IN (${Prisma.join(judgingCrucibleIds)})
            ))`
          : Prisma.empty
      }
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
      ${
        shownReviewImageLevels === undefined
          ? Prisma.empty
          : Prisma.sql`OR (i."postId" IS NULL AND ${shownReviewImageSql(shownReviewImageLevels)})`
      }
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
    ...imageBlockedForConditions({ userId, ownerKeepsBlockedRow }),
    imageNotRestrictedSql({ viewerId: userId }),
    // Without the opt-in, a review image is closed to its uploader too (moderators aside); with it,
    // one whose source Final is held still is. A deal file's own copy is closed either way.
    shownReviewImageLevels === undefined
      ? notServerCopySql
      : Prisma.sql`(${notHeldReviewCopySql} AND ${notDealFileCopySql})`,
    ...(music === false ? [songsHiddenSql({ music, ownerId: userId })!] : []),
  ];
}

export { canSeeSongs, songsHiddenSql };

/**
 * `songsHiddenSql` over rows already read, for a cache filled for every viewer: `rows` without the
 * songs `viewer` may not see (signed out when undefined).
 */
export function withoutHiddenSongs<T extends { type?: string | null; userId?: number | null }>(
  rows: T[],
  viewer: SessionUser | undefined
) {
  if (canSeeSongs(viewer)) return rows;
  return rows.filter((row) => row.type !== 'audio' || (!!viewer && row.userId === viewer.id));
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
  judgingCrucibleIds,
  music = false,
}: {
  id: number;
  userId?: number;
  isModerator?: boolean;
  /**
   * The viewer's `music` flag (`ctx.features.music`, or `canSeeSongs`). Left out, a song is not
   * found except by its owner and moderators.
   */
  music?: boolean;
  /** `imageVisibilityConditions`' `ownerSeesHeld`. */
  ownerSeesHeld?: boolean;
  /** `imageVisibilityConditions`' `judgingCrucibleIds`. */
  judgingCrucibleIds?: number[];
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
    ? Prisma.sql`(${Prisma.join(
        // Signed out holds no `music` flag.
        [Prisma.sql`TRUE`, ...imageVisibilityConditions({ music: false })],
        ' AND '
      )})`
    : Prisma.sql`NULL::boolean`;
  // Through Kysely over the pg pools, not Prisma's `$queryRaw`: one of the hottest single-image
  // reads, and the same statement and parameters either way (`queryPrismaSql`). Every column is
  // int4, boolean or text, which both executors parse alike.
  // An id past int4 names no image: not found, as Prisma answered, rather than a range error.
  if (!isPgInt4(id)) throw throwNotFoundError();
  const { kyselyRead } = await loadKyselyDb();
  const [visible] = await queryPrismaSql<{
    id: number;
    userId: number;
    nsfwLevel: number;
    postId: number | null;
    ingestion: string;
    blockedFor: string | null;
    visibleSignedOut: boolean | null;
  }>(
    kyselyRead,
    Prisma.sql`
    SELECT i.id, i."userId", i."nsfwLevel", i."postId", i.ingestion::text AS ingestion,
      i."blockedFor", ${signedOutVerdict} AS "visibleSignedOut"
    FROM "Image" i
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE ${Prisma.join(
      [
        Prisma.sql`i.id = ${id}`,
        ...imageVisibilityConditions({
          userId,
          isModerator,
          ownerSeesHeld,
          judgingCrucibleIds,
          music,
          ownerKeepsBlockedRow: true,
        }),
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

/** What a report on content that is gone is told; also a review image the reporter may not open. */
export const REPORTED_CONTENT_GONE = 'The content you are trying to report no longer exists';

/**
 * NOT_FOUND, with the answer an id that names no image gets, unless `id` is an image and, when it is
 * a service review image, the reporter may open it (the image page's rule, blocks included). Other
 * images are reportable whether or not the reporter can open them.
 */
export async function assertImageReportable({
  id,
  userId,
  isModerator,
  shownReviewImageLevels,
}: {
  id: number;
  userId: number;
  isModerator?: boolean;
  shownReviewImageLevels?: number;
}) {
  if (!isPgInt4(id)) throw throwNotFoundError(REPORTED_CONTENT_GONE);
  // primary: the image may have been uploaded a moment ago.
  const [image] = await dbWrite.$queryRaw<
    { buyerId: number; sellerId: number | null; visible: boolean | null }[]
  >`
    SELECT i."userId" AS "buyerId", d."sellerId",
      -- IS TRUE: a WHERE drops a NULL verdict (a postless image's post terms), a select keeps it.
      CASE WHEN ri."imageId" IS NULL THEN NULL ELSE (${Prisma.join(
        [
          Prisma.sql`TRUE`,
          ...imageVisibilityConditions({
            userId,
            isModerator,
            shownReviewImageLevels,
            ownerKeepsBlockedRow: true,
          }),
        ],
        ' AND '
      )}) IS TRUE END AS "visible"
    FROM "Image" i
    LEFT JOIN "Post" p ON p.id = i."postId"
    LEFT JOIN "ServiceDealReviewImage" ri ON ri."imageId" = i.id
    LEFT JOIN "ServiceDealReview" sr ON sr.id = ri."reviewId"
    LEFT JOIN "ServiceDeal" d ON d.id = sr."dealId"
    WHERE i.id = ${id}`;
  if (!image || image.visible === false) throw throwNotFoundError(REPORTED_CONTENT_GONE);
  if (image.sellerId === null) return;
  const blocked = await isReviewImageBlockedForViewer({
    viewerId: userId,
    buyerId: image.buyerId,
    sellerId: image.sellerId,
    isModerator,
  });
  if (blocked) throw throwNotFoundError(REPORTED_CONTENT_GONE);
}

/**
 * Whether a block either way between the viewer and a review image's buyer or seller hides it from
 * the viewer, as on the review. Moderators and the buyer always see it; so does a signed-out viewer.
 */
export async function isReviewImageBlockedForViewer({
  viewerId,
  buyerId,
  sellerId,
  isModerator,
}: {
  viewerId?: number;
  buyerId: number;
  sellerId: number;
  isModerator?: boolean;
}) {
  if (!viewerId || isModerator || viewerId === buyerId) return false;
  const blockedPair = await getBlockedPairIds(viewerId);
  return blockedPair.includes(buyerId) || blockedPair.includes(sellerId);
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
          ...imageVisibilityConditions({ userId, isModerator, ownerKeepsBlockedRow: true }),
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

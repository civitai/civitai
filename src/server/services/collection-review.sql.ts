import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import { imageReviewedSql } from '~/server/common/image-visibility';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { ArticleStatus, ModelModifier, ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * Whether a collection item's target would survive the review queue's hydration, as SQL over a
 * `CollectionItem` aliased `ci`. Shared by the queue's `forReview` read and both pending counts, so
 * a badge cannot count items the queue never shows.
 *
 * `getCollectionItemsByCollectionId` hydrates REVIEW rows through the feed services as the reviewer
 * at the request's `browsingLevel`, and drops every row whose target does not come back. The review
 * page asks for every level, which the domain cap holds to PG/PG-13 on the SFW site, so `levels` is
 * that ceiling: a badge on civitai.com must not count mature items only civitai.red can show. Each branch mirrors the clauses that decide that:
 * - Model: `getModelsRaw` reads `ModelMetric`'s denormalized status/mode/nsfwLevel (Published, not
 *   Archived) and leaves out Private models; `getModelsWithImagesAndModelVersions` drops TakenDown.
 * - Image: `getAllImages` with `pending` and `reviewCollectionId` keeps the collection's unrated
 *   and `acceptableMinor` images only when their uploader submitted them, with the same image and
 *   post filters as any read of the image.
 * - Post: `getPostsInfinite` without a `username` keeps published, non-Private posts.
 * - Article: `getArticles` requires Published with a publish date, and a finished scan.
 * - Model3D: no branch. The queue never selects `model3dId`, so it shows none of them.
 *
 * No browsing level includes the top level bit, so a target rated only at it never hydrates and is not
 * counted either. Only images keep nsfwLevel 0 (`pending`). A rated image must also pass the ingestion
 * check every read applies (`imageReviewedSql`), so a rated image the public reads would not show
 * stays out of the queue.
 * The CASE order is hydration's: a row with two target columns is judged by the first one only.
 *
 * NOT mirrored: drops made after the SQL in hydration (a model with no published version or no
 * images, a post with no images), the browsing-settings tag exclusions, which come from config per
 * level, and the exceptions every read makes for the viewer's own content. Those cost a join per row and are rare states; the queue can
 * still show slightly fewer items than the count for them.
 */
export const reviewQueueVisibleTargetSql = (levels: number) => Prisma.sql`(CASE
  WHEN ci."modelId" IS NOT NULL THEN EXISTS (
    SELECT 1 FROM "ModelMetric" rv_mm
    WHERE rv_mm."modelId" = ci."modelId"
      AND rv_mm."status" = ${ModelStatus.Published}::"ModelStatus"
      AND (rv_mm."nsfwLevel" & ${levels}) != 0
      AND (rv_mm."mode" IS NULL OR rv_mm."mode" NOT IN (
        ${ModelModifier.Archived}::"ModelModifier", ${ModelModifier.TakenDown}::"ModelModifier"
      ))
      AND rv_mm."availability" != 'Private'::"Availability"
  )
  WHEN ci."postId" IS NOT NULL THEN EXISTS (
    SELECT 1 FROM "Post" rv_p
    WHERE rv_p.id = ci."postId"
      AND rv_p."publishedAt" <= now()
      AND rv_p."availability" != 'Private'::"Availability"
      AND (rv_p."nsfwLevel" & ${levels}) != 0
  )
  WHEN ci."imageId" IS NOT NULL THEN EXISTS (
    SELECT 1 FROM "Image" rv_i
    JOIN "Post" rv_ip ON rv_ip.id = rv_i."postId"
    WHERE rv_i.id = ci."imageId"
      AND ((rv_i."nsfwLevel" & ${levels}) != 0 OR rv_i."nsfwLevel" = 0)
      AND ((rv_i."nsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0 OR NOT rv_i."modelRestricted")
      AND (rv_i."nsfwLevel" = 0 OR ${imageReviewedSql('rv_i')})
      AND rv_i."needsReview" IS NULL
      AND ((rv_i."nsfwLevel" != 0 AND NOT rv_i."acceptableMinor") OR ci."addedById" = rv_i."userId")
      AND rv_i."ingestion" != 'Blocked'::"ImageIngestionStatus"
      AND rv_i."blockedFor" IS NULL
      AND rv_ip."availability" != 'Private'::"Availability"
      AND rv_ip."publishedAt" <= now()
      AND rv_ip."metadata"->>'unpublishedAt' IS NULL
  )
  WHEN ci."articleId" IS NOT NULL THEN EXISTS (
    SELECT 1 FROM "Article" rv_a
    WHERE rv_a.id = ci."articleId"
      AND rv_a."status" = ${ArticleStatus.Published}::"ArticleStatus"
      AND rv_a."publishedAt" IS NOT NULL
      AND rv_a."ingestion" = 'Scanned'::"ArticleIngestionStatus"
      AND (rv_a."nsfwLevel" & ${levels}) != 0
  )
  ELSE false
END)`;

type ReviewViewer = { collectionId: number; userId: number };

// `i` is a REVIEW or REJECTED submission of the collection, added by the image's own uploader, and
// the viewer owns the collection or has MANAGE on it.
const reviewSubmissionSql = ({ collectionId, userId }: ReviewViewer) => Prisma.sql`EXISTS (
  SELECT 1 FROM "CollectionItem" rci
  JOIN "Collection" rc ON rc.id = rci."collectionId"
  WHERE rci."imageId" = i.id
    AND rci."collectionId" = ${collectionId}
    AND rci."status" IN ('REVIEW', 'REJECTED')
    AND rci."addedById" = i."userId"
    AND (rc."userId" = ${userId} OR EXISTS (
      SELECT 1 FROM "CollectionContributor" rcc
      WHERE rcc."collectionId" = rc.id AND rcc."userId" = ${userId}
        AND rcc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[]
    ))
)`;

/**
 * The images a collection's reviewer may see before they are rated: those that are REVIEW or
 * REJECTED submissions of that collection by their uploader, when the viewer owns it or has MANAGE on it. Used as an
 * arm of `getAllImages`' pending filter over `Image` aliased `i`; every other filter of that read
 * still applies.
 */
export const reviewCollectionImageSql = (viewer: ReviewViewer) =>
  Prisma.sql`(i."nsfwLevel" = 0 AND ${reviewSubmissionSql(viewer)})`;

/**
 * `getAllImages`' `pending` filter for a signed-in non-moderator, over `Image` aliased `i` joined to
 * its `Post` aliased `p`. Another user's image must pass the same checks as any read of it: not
 * awaiting review, rated within `browsingLevel`, reviewed (`imageReviewedSql`), and not
 * `acceptableMinor`. The viewer's own images are exempt from all four.
 *
 * Two widenings, both scoped to collections the viewer manages:
 * - a post in a collection they MANAGE shows its rated, reviewed images above `browsingLevel`
 *   (never unrated or Blocked ones);
 * - with the server-set `reviewCollectionId`, that collection's REVIEW and REJECTED submissions by
 *   their uploader show unrated, and `acceptableMinor` ones show too, so a judge can reject them.
 *   That exception does not reach above `browsingLevel`.
 */
export const pendingViewerImageSql = ({
  userId,
  browsingLevel,
  reviewCollectionId,
}: {
  userId: number;
  browsingLevel: number;
  reviewCollectionId?: number;
}) => {
  const own = Prisma.sql`i."userId" = ${userId}`;
  const review = reviewCollectionId ? { collectionId: reviewCollectionId, userId } : undefined;
  return Prisma.sql`((i."needsReview" IS NULL OR ${own})
    AND (i."acceptableMinor" = FALSE OR ${own}${
    review ? Prisma.sql` OR ${reviewSubmissionSql(review)}` : Prisma.empty
  })
    AND (${own} OR i."nsfwLevel" = 0 OR ${imageReviewedSql()})
    AND ((i."nsfwLevel" & ${browsingLevel}) != 0 OR (i."nsfwLevel" = 0 AND ${own}) OR (p."collectionId" IS NOT NULL AND i."nsfwLevel" NOT IN (0, ${
    NsfwLevel.Blocked
  }) AND (i."acceptableMinor" = FALSE OR ${own}) AND EXISTS (SELECT 1 FROM "CollectionContributor" cc WHERE cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[] AND cc."collectionId" = p."collectionId" AND cc."userId" = ${userId}))${
    review ? Prisma.sql` OR ${reviewCollectionImageSql(review)}` : Prisma.empty
  }))`;
};

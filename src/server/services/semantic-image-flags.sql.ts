import {
  CSAM_REPORT_LISTED_IMAGE_IDS_SQL,
  heldImageSql,
  heldItemImageSql,
} from '@civitai/shared/held-media';

/**
 * The "Image" row aliased `image` is under CSAM review, blocked as CSAM, or listed on a CsamReport,
 * so the semantic search indexes never embed or return it. Never NULL, so NOT of it is safe on an unflagged image. The
 * event-engine's vector-sync/image-flags.ts csamFlaggedImageSql is its copy, pinned to it by
 * semantic-image-flags.test.ts.
 */
export const semanticImageCsamFlaggedText = (image: string) =>
  `COALESCE((${heldItemImageSql(
    image
  )} OR (${image}.id)::text IN (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL})), false)`;

/**
 * The cover `column` (an "Image" id) is empty or names a scanned, unflagged, rated image. The
 * event-engine's vector-sync/image-flags.ts coverImageCleanSql is its copy, pinned to it by the
 * comic and storyline eligibility parity tests.
 */
export const semanticCoverImageCleanText = (column: string) =>
  `(${column} IS NULL OR EXISTS (SELECT 1 FROM "Image" ci WHERE ci.id = ${column}
    AND ci.ingestion = 'Scanned' AND ci."needsReview" IS NULL AND ci."tosViolation" = false
    AND ci."blockedFor" IS NULL AND ci.minor = false AND ci.poi = false
    AND ci."nsfwLevel" NOT IN (0, 32) AND NOT ${semanticImageCsamFlaggedText('ci')}))`;

/**
 * The "Image" row aliased `image` is held (`heldImageSql`) or listed on a CsamReport.
 */
export const semanticImageHeldText = (image: string) =>
  `COALESCE((${heldImageSql(
    image
  )} OR (${image}.id)::text IN (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL})), false)`;

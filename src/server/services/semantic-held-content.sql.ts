import { CSAM_REPORT_LISTED_IMAGE_IDS_SQL, heldImageSql } from '@civitai/shared/held-media';

/**
 * The "Image" row aliased `image` is held (`heldImageSql`) or listed on a CsamReport, so the semantic
 * search indexes never embed or return it. Never NULL: heldImageSql's comparisons are NULL on an
 * unflagged image, which NOT would turn into exclusion. The event-engine's vector-sync/held.ts
 * heldImageSql is its copy, pinned to it by semantic-held-content.test.ts.
 */
export const semanticImageHeldText = (image: string) =>
  `COALESCE((${heldImageSql(
    image
  )} OR (${image}.id)::text IN (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL})), false)`;

/**
 * The cover `column` (an "Image" id) is empty or names a scanned, unflagged, rated image that is not
 * held. The event-engine's vector-sync/held.ts coverImageCleanSql is its copy, pinned to it by the
 * comic and storyline eligibility parity tests.
 */
export const semanticCoverImageCleanText = (column: string) =>
  `(${column} IS NULL OR EXISTS (SELECT 1 FROM "Image" ci WHERE ci.id = ${column}
    AND ci.ingestion = 'Scanned' AND ci."needsReview" IS NULL AND ci."tosViolation" = false
    AND ci."blockedFor" IS NULL AND ci.minor = false AND ci.poi = false
    AND ci."nsfwLevel" NOT IN (0, 32) AND NOT ${semanticImageHeldText('ci')}))`;

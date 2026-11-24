import { CSAM_REPORT_LISTED_IMAGE_IDS_SQL, heldImageSql } from '@civitai/shared/held-media';

/**
 * The "Image" row aliased `image` is under CSAM review or blocked as CSAM, so the semantic search
 * indexes never embed or return it. Never NULL, so NOT of it is safe on an unflagged image. The
 * event-engine's vector-sync/image-flags.ts csamFlaggedImageSql is its copy, pinned to it by
 * semantic-image-flags.test.ts.
 */
export const semanticImageCsamFlaggedText = (image: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  return `COALESCE((${image}."needsReview" = 'csam' OR ${image}."blockedFor" = 'CSAM'), false)`;
};

/**
 * The cover `column` (an "Image" id) is empty or names a scanned, unflagged, rated image. The
 * event-engine's vector-sync/image-flags.ts coverImageCleanSql is its copy, pinned to it by the
 * comic and storyline eligibility parity tests.
 */
export const semanticCoverImageCleanText = (column: string) =>
  `(${column} IS NULL OR EXISTS (SELECT 1 FROM "Image" ci WHERE ci.id = ${column}
    AND ci.ingestion = 'Scanned' AND ci."needsReview" IS NULL AND ci."tosViolation" = false
    AND ci."blockedFor" IS NULL AND ci.minor = false AND ci.poi = false
    AND ci."nsfwLevel" NOT IN (0, 32)))`;

/**
 * The "Image" row aliased `image` is held (`heldImageSql`) or listed on a CsamReport. Storyline
 * image visibility only (storyline.service.ts); search no longer reads it.
 */
export const semanticImageHeldText = (image: string) =>
  `COALESCE((${heldImageSql(
    image
  )} OR (${image}.id)::text IN (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL})), false)`;

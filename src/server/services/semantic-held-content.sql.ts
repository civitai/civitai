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

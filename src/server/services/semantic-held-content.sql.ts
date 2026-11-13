import { heldImageSql } from '@civitai/shared/held-media';

/**
 * Held content kept out of the semantic search indexes, as SQL text: it is never embedded and never
 * returned. The event-engine's vector-sync/held.ts is its copy, held to it by each index's
 * eligibility parity test.
 */

/** Image ids listed on any CsamReport, whatever its state: `csamReportListedImageIdsSql`. */
const CSAM_LISTED_IMAGE_IDS = `SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL`;

/**
 * The "Image" row aliased `image` is held (`heldImageSql`) or listed on a CsamReport. Never NULL:
 * heldImageSql's comparisons are NULL on an unflagged image, which NOT would turn into exclusion.
 */
/** An alias (`ti`) or an aliased column (`m."userId"`): the SQL below splices it as written. */
function sqlRef(ref: string) {
  if (!/^[a-z_][a-z0-9_]*(\."[a-z_][a-z0-9_]*")?$/i.test(ref))
    throw new Error(`Bad SQL reference: ${ref}`);
  return ref;
}

export const semanticImageHeldText = (image: string) =>
  `COALESCE((${heldImageSql(
    sqlRef(image)
  )} OR (${image}.id)::text IN (${CSAM_LISTED_IMAGE_IDS})), false)`;

/** The user `column` is named on a CsamReport (subject or secondary) or under an evidence hold. */
export const semanticUserHeldText = (column: string) => `(
    EXISTS (SELECT 1 FROM "CsamReport" ur WHERE ur."userId" = ${sqlRef(column)})
    OR EXISTS (
      SELECT 1 FROM "CsamReport" us
      WHERE CASE WHEN us.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
                 THEN (us.details ->> 'secondaryUserId')::bigint END = ${column}
    )
    OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" ue WHERE ue."userId" = ${column})
  )`;

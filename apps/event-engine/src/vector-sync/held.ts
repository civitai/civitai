/**
 * Held content kept out of the content indexes: never embedded, and deleted when it becomes held.
 * A copy of the site's semantic-held-content.sql.ts (which composes @civitai/shared's
 * heldImageSql, which the event-engine cannot import), held to it by each index's eligibility
 * parity test.
 */

/** The owner deleted accounts hand kept content to; a report naming it holds nothing. */
const PLACEHOLDER_OWNER_ID = -1;

const CSAM_LISTED_IMAGE_IDS = `SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL`;

/** The user `column` is named on a CsamReport (subject or secondary) or under an evidence hold. */
export const heldUserSql = (column: string) => `(
    EXISTS (SELECT 1 FROM "CsamReport" ur WHERE ur."userId" = ${column})
    OR EXISTS (
      SELECT 1 FROM "CsamReport" us
      WHERE CASE WHEN us.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
                 THEN (us.details ->> 'secondaryUserId')::bigint END = ${column}
    )
    OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" ue WHERE ue."userId" = ${column})
  )`;

/**
 * The "Image" row aliased `image` is flagged or blocked for CSAM, its owner is held, or a CsamReport
 * lists it. Never NULL, so NOT of it is safe on an unflagged image.
 */
export const heldImageSql = (image: string) => `COALESCE((
    ${image}."needsReview" = 'csam'
    OR ${image}."blockedFor" = 'CSAM'
    OR (${image}."userId" <> ${PLACEHOLDER_OWNER_ID}
      AND ${image}."blockedFor" IS DISTINCT FROM 'AiNotVerified' AND ${heldUserSql(
  `${image}."userId"`
)})
    OR (${image}.id)::text IN (${CSAM_LISTED_IMAGE_IDS})
  ), false)`;

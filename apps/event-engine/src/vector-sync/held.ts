/**
 * Held content kept out of the content indexes: never embedded, and deleted when it becomes held.
 * A copy of @civitai/shared/held-media's heldUserSql and the site's semanticImageHeldText: this app
 * depends on no workspace package (see its MIGRATION.md). semantic-held-content.test.ts pins each
 * function's SQL to its original, text for text.
 */

/** The owner deleted accounts hand kept content to; a report naming it holds nothing. */
const PLACEHOLDER_OWNER_ID = -1;

const CSAM_REPORT_LISTED_IMAGE_IDS_SQL = `SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL`;

/** An alias (`i`) or an aliased column (`m."userId"`), checked because the SQL splices it as written. */
function sqlRef(ref: string): string {
  if (!/^[a-z_][a-z0-9_]*(\."[a-z_][a-z0-9_]*")?$/i.test(ref))
    throw new Error(`Bad SQL reference: ${ref}`);
  return ref;
}

/** The user `column` is named on a CsamReport (subject or secondary user) or under an evidence hold. */
export function heldUserSql(column: string): string {
  const user = sqlRef(column);
  return `(
      EXISTS (SELECT 1 FROM "CsamReport" hr WHERE hr."userId" = ${user})
      -- Uncorrelated, so Postgres reads the reports once per statement rather than once per row.
      -- CASE as well as the filter: Postgres may cast before it tests the pattern, and one bad
      -- row would fail every request. The filter keeps NULLs out, so IN is never unknown.
      OR COALESCE(${user} IN (
        SELECT CASE WHEN hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
                    THEN (hs.details ->> 'secondaryUserId')::bigint END
        FROM "CsamReport" hs
        WHERE hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
      ), false)
      OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" he WHERE he."userId" = ${user})
    )`;
}

/**
 * The "Image" row aliased `image` is flagged or blocked for CSAM, its owner is held, or a CsamReport
 * lists it. Never NULL, so NOT of it is safe on an unflagged image.
 */
export function heldImageSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  const owner = `${image}."userId"`;
  const flagged = `(
    ${image}."needsReview" = 'csam'
    OR ${image}."blockedFor" = 'CSAM'
    OR (${owner} <> ${PLACEHOLDER_OWNER_ID}
      AND ${image}."blockedFor" IS DISTINCT FROM 'AiNotVerified' AND ${heldUserSql(owner)})
  )`;
  return `COALESCE((${flagged} OR (${image}.id)::text IN (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL})), false)`;
}

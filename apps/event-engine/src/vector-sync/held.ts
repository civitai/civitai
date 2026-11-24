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
      -- Compared as text, the form "CsamReport_secondaryUserId_idx" indexes, so Postgres picks an
      -- index probe per row for a few rows or one hashed read per statement for many. The app
      -- writes the id as a JSON number, whose text is canonical; a hand-written "007" matches no one,
      -- and the pattern keeps a negative id matching no one, as before.
      OR EXISTS (
        SELECT 1 FROM "CsamReport" hs
        WHERE hs.details ->> 'secondaryUserId' = (${user})::text
          AND hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
      )
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

/**
 * The cover `column` (an "Image" id) is empty or names a scanned, unflagged, rated image that is not
 * held: the site's semanticCoverImageCleanText, pinned to it by the comic and storyline eligibility
 * parity tests.
 */
export function coverImageCleanSql(column: string): string {
  const cover = sqlRef(column);
  return `(${cover} IS NULL OR EXISTS (SELECT 1 FROM "Image" ci WHERE ci.id = ${cover}
    AND ci.ingestion = 'Scanned' AND ci."needsReview" IS NULL AND ci."tosViolation" = false
    AND ci."blockedFor" IS NULL AND ci.minor = false AND ci.poi = false
    AND ci."nsfwLevel" NOT IN (0, 32) AND NOT ${heldImageSql('ci')}))`;
}

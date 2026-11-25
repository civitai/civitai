/**
 * Image checks the content indexes share, copied from the site's semantic-image-flags.sql.ts: this app
 * depends on no workspace package (see its MIGRATION.md). semantic-image-flags.test.ts pins each
 * function's SQL to its original, text for text.
 */

const CSAM_REPORT_LISTED_IMAGE_IDS_SQL = `SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL`;

/**
 * The "Image" row aliased `image` is under CSAM review, blocked as CSAM, or listed on a CsamReport.
 * Never NULL, so NOT of it is safe on an unflagged image.
 */
export function csamFlaggedImageSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  return `COALESCE(((${image}."needsReview" = 'csam' OR ${image}."blockedFor" = 'CSAM') OR (${image}.id)::text IN (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL})), false)`;
}

/** An aliased column (`st."coverImageId"`), checked because the SQL splices it as written. */
function sqlRef(ref: string): string {
  if (!/^[a-z_][a-z0-9_]*(\."[a-z_][a-z0-9_]*")?$/i.test(ref))
    throw new Error(`Bad SQL reference: ${ref}`);
  return ref;
}

/**
 * The cover `column` (an "Image" id) is empty or names a scanned, unflagged, rated image: the site's
 * semanticCoverImageCleanText, pinned to it by the comic and storyline eligibility parity tests.
 */
export function coverImageCleanSql(column: string): string {
  const cover = sqlRef(column);
  return `(${cover} IS NULL OR EXISTS (SELECT 1 FROM "Image" ci WHERE ci.id = ${cover}
    AND ci.ingestion = 'Scanned' AND ci."needsReview" IS NULL AND ci."tosViolation" = false
    AND ci."blockedFor" IS NULL AND ci.minor = false AND ci.poi = false
    AND ci."nsfwLevel" NOT IN (0, 32) AND NOT ${csamFlaggedImageSql('ci')}))`;
}

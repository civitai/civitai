import { sql, type RawBuilder } from 'kysely';
import { evidenceVerifiedText } from '@civitai/shared/held-url';
import { OWNER_HIDDEN_REVIEWS } from '@civitai/shared/owner-hidden-reviews';
import { CHILD_SAFETY_VIOLATIONS } from '@civitai/shared/post-text-report';

// An image or post in an open child-safety case: what keeps a delete of it until the case closes
// (docs/features/pending-deletes.md).

const openChildSafetyReport = (reportId: RawBuilder<unknown>) => sql<boolean>`EXISTS (
  SELECT 1 FROM "Report" cs_r
  WHERE cs_r.id = ${reportId}
    AND cs_r.status IN ('Pending', 'Processing')
    AND (cs_r.reason = 'CSAM' OR (cs_r.reason = 'TOSViolation'
      AND cs_r.details ->> 'violation' IN (${sql.join([...CHILD_SAFETY_VIOLATIONS])})))
)`;

const postReported = (postId: RawBuilder<unknown>) => sql<boolean>`EXISTS (
  SELECT 1 FROM "PostReport" cs_pr
  WHERE cs_pr."postId" = ${postId} AND ${openChildSafetyReport(sql.ref('cs_pr.reportId'))}
)`;

/**
 * The image's CyberTip is filed with verified evidence. A report lists an image as `{"id": n}` or a
 * bare id, number or text.
 */
const evidenceFiled = (id: RawBuilder<unknown>) => sql<boolean>`EXISTS (
  SELECT 1 FROM "CsamReport" cs_cr
  -- CASE, not AND, so the cheap images test runs first and "details" is only read on a match.
  WHERE CASE
    WHEN jsonb_typeof(cs_cr.images) = 'array' AND (
      cs_cr.images @> jsonb_build_array(jsonb_build_object('id', ${id}))
      OR cs_cr.images @> jsonb_build_array(jsonb_build_object('id', ${id}::text))
      OR cs_cr.images @> jsonb_build_array(${id})
      OR cs_cr.images @> jsonb_build_array(${id}::text)
    )
    THEN cs_cr."reportSentAt" IS NOT NULL AND ${sql.raw(evidenceVerifiedText('cs_cr'))}
    ELSE false
  END
)`;

// Each leg is a CASE so its subquery runs only on a row the leg can hold: an AND whose first test is
// NULL (no flag, the usual image) still evaluates its second.

/**
 * Blocked for CSAM, until its CyberTip is filed with verified evidence. Read against `image` (a
 * table name or alias). The broader "held" rule is `heldImageSql` in @civitai/shared/held-media.
 */
const csamBlockOpen = (image: string) => {
  const col = (name: string) => sql.ref(`${image}.${name}`);
  return sql<boolean>`CASE WHEN ${col('blockedFor')} = 'CSAM'
    THEN NOT ${evidenceFiled(col('id'))} ELSE false END`;
};

/** Under CSAM review, until the CSAM queue dismisses it; once blocked as CSAM, the block decides. */
const csamReviewOpen = (image: string) => {
  const col = (name: string) => sql.ref(`${image}.${name}`);
  return sql<boolean>`CASE WHEN ${col('needsReview')} = 'csam'
    AND ${col('blockedFor')} IS DISTINCT FROM 'CSAM'
    THEN NOT EXISTS (
      SELECT 1 FROM "CsamQueueSetAside" cs_s
      WHERE cs_s."imageId" = ${col('id')} AND cs_s.outcome = 'Dismissed'
    )
    ELSE false END`;
};

/**
 * A child-safety case its owner can already see, read against `image`: the image is served to them
 * as blocked. Only this case may tell the owner their delete waits on a review.
 */
export const childSafetyVisibleCase = (image = 'Image') => {
  const needsReview = sql.ref(`${image}.needsReview`);
  return sql<boolean>`(${csamBlockOpen(image)}
    AND COALESCE(${needsReview}, '') <> ALL(${sql.val([...OWNER_HIDDEN_REVIEWS])}::text[]))`;
};

/**
 * An image in an open child-safety case, read against `image`: under CSAM review, blocked for CSAM,
 * or under an open child-safety report on itself or its post. A delete that reaches it waits for the
 * case to close.
 */
export const childSafetyImageCase = (image = 'Image') => {
  const col = (name: string) => sql.ref(`${image}.${name}`);
  return sql<boolean>`(
    ${csamReviewOpen(image)}
    OR ${csamBlockOpen(image)}
    OR EXISTS (
      SELECT 1 FROM "ImageReport" cs_ir
      WHERE cs_ir."imageId" = ${col('id')} AND ${openChildSafetyReport(sql.ref('cs_ir.reportId'))}
    )
    OR CASE WHEN ${col('postId')} IS NOT NULL THEN ${postReported(col('postId'))} ELSE false END
  )`;
};

/** A post under an open child-safety report, read against `post`; deleting it takes the report. */
export const childSafetyPostCase = (post = 'Post') => postReported(sql.ref(`${post}.id`));

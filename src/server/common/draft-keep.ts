import { CSAM_REPORT_LISTED_IMAGE_IDS_SQL } from '@civitai/shared/held-media';
import { moderatorActedBeforeDeleteSql } from '~/server/common/model-moderator-action';

/**
 * The drafts the old-drafts reaper keeps, as SQL over the "Model" row aliased `m`. The reaper's
 * read and its DELETE use it, and so does the `old-draft` warning, so a kept draft is never warned.
 * Plain strings with no parameters: the warning's query is a string.
 */

const alias = (m: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(m)) throw new Error(`Bad table alias: ${m}`);
  return m;
};

const asArray = (json: string) =>
  `CASE WHEN jsonb_typeof(${json}) = 'array' THEN ${json} ELSE '[]'::jsonb END`;

/** Everyone a CsamReport names, as its subject or its secondary user, whatever its status, as text. */
const REPORTED_USER_IDS_SQL = `
  SELECT ru."userId"::text FROM "CsamReport" ru WHERE ru."userId" IS NOT NULL
  UNION
  SELECT rs.details ->> 'secondaryUserId' FROM "CsamReport" rs
  WHERE rs.details ->> 'secondaryUserId' IS NOT NULL`;

/** Every version a CsamReport lists, or names as a resource of a generated image it reports, as text. */
const REPORTED_VERSION_IDS_SQL = `
  SELECT rv.id FROM "CsamReport" rvr
  CROSS JOIN LATERAL jsonb_array_elements_text(${asArray(
    `rvr.details -> 'modelVersionIds'`
  )}) rv(id)
  UNION
  SELECT substring(rr.air from ':civitai:[0-9]+@([0-9]+)') FROM "CsamReport" rgr
  CROSS JOIN LATERAL jsonb_array_elements(${asArray(`rgr.details -> 'generatedImages'`)}) rg
  CROSS JOIN LATERAL jsonb_array_elements_text(${asArray(`rg -> 'resources'`)}) rr(air)`;

/** The image ids a CsamReport lists that fit an int, so a lookup by image id can use its index. */
const LISTED_IMAGE_INT_IDS_SQL = `
  SELECT CASE WHEN li.id ~ '^[0-9]{1,9}$' THEN li.id::int END
  FROM (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL}) li`;

/** A model a moderator acted on: taken down, deleted by someone other than its owner, or deleted by
 *  its owner after a moderator had taken it down (`moderatorActedBeforeDeleteSql`, which the creator
 *  score reads too). An owner's own delete, and an account delete (no actor), stay reapable otherwise. */
export function draftModeratedSql(model: string): string {
  const m = alias(model);
  return `(${m}.mode::text IS NOT DISTINCT FROM 'TakenDown'
  OR (${m}.status::text = 'Deleted' AND ${m}."deletedBy" IS NOT NULL AND ${m}."deletedBy" <> ${m}."userId")
  OR (${m}.status::text = 'Deleted' AND ${moderatorActedBeforeDeleteSql(m)}))`;
}

/** A model tied to any CsamReport, whatever its status: one naming its owner,
 *  listing or naming as a resource one of its versions, or listing an image posted to one of its
 *  versions or made with one. The sets do not read the model row. */
export function draftReportTiedSql(model: string): string {
  const m = alias(model);
  return `(
  (${m}."userId")::text IN (${REPORTED_USER_IDS_SQL})
  OR EXISTS (
    SELECT 1 FROM "ModelVersion" cv
    WHERE cv."modelId" = ${m}.id AND (cv.id)::text IN (${REPORTED_VERSION_IDS_SQL})
  )
  OR EXISTS (
    SELECT 1 FROM "ModelVersion" iv
    JOIN "Post" ip ON ip."modelVersionId" = iv.id
    JOIN "Image" ii ON ii."postId" = ip.id
    WHERE iv."modelId" = ${m}.id AND (ii.id)::text IN (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL})
  )
  OR EXISTS (
    SELECT 1 FROM "ImageResourceNew" ir
    JOIN "ModelVersion" rv ON rv.id = ir."modelVersionId"
    WHERE rv."modelId" = ${m}.id AND ir."imageId" IN (${LISTED_IMAGE_INT_IDS_SQL})
  )
)`;
}

/** Every draft the reaper keeps and the warning skips. */
export function draftKeptSql(model: string): string {
  return `(${draftModeratedSql(model)} OR ${draftReportTiedSql(model)})`;
}

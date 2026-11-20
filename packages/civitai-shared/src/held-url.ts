import { CSAM_REPORT_LISTED_IMAGE_IDS_SQL, sqlRef } from './held-media';

/**
 * When the image CDN must not retract a stored url: the url-level hold that the main app's
 * cdn-access sync caps a retraction at, as plain SQL, so the moderator app's retracted-media route
 * reads the same answer. Each function takes column references only (`sqlRef`); ids stay bound
 * parameters in the caller's statement.
 */

/** `Post.metadata.unpublishedReason` written by a csam-hold removal of a post. */
export const CSAM_HOLD_POST_UNPUBLISH_REASON = 'csam-text-hold';
/**
 * Written by a csam-hold removal of a model and by ordinary moderation alike; both are held until a
 * verified report covers the image.
 */
export const MATURE_UNDERAGE_REASON = 'mature-underage';
/** Unpublish reasons that also say the model depicts a minor. */
export const MINOR_UNPUBLISH_REASONS = ['mature-underage', 'photo-real-underage'] as const;
/** Text-scan hold `hold` (an alias) is a CSAM hold not dismissed: Pending or Confirmed. */
export function liveCsamTextHoldText(hold: string): string {
  const h = sqlRef(hold);
  return `(${h}.label = 'csam' AND ${h}.status IN ('Pending', 'Confirmed'))`;
}
/** Post text `text` (an alias) is CSAM-held: flagged, or under a live CSAM text hold. */
export function postTextCsamHeldText(text: string): string {
  const t = sqlRef(text);
  if (t === 'pth') throw new Error(`Alias taken inside postTextCsamHeldText: ${t}`);
  return `(${t}."csamHeld" OR EXISTS (SELECT 1 FROM "TextScanHold" pth
    WHERE pth."entityType" = 'PostText' AND pth."entityId" = ${t}.id AND ${liveCsamTextHoldText(
    'pth'
  )}))`;
}
/**
 * Entity `entity` (a column reference or an integer literal) of `entityType` is held for the CSAM
 * queue: a live CSAM text hold, or a csam verdict no moderator dismissed for its text, since the
 * verdict is recorded before its hold is written. Like `csamHoldBars`, but a Confirmed hold bars here
 * too.
 */
export function csamQueueHeldText(entityType: string, entity: string): string {
  if (!/^[A-Za-z]+$/.test(entityType)) throw new Error(`Bad entity type: ${entityType}`);
  const e = /^d{1,18}$/.test(entity) ? entity : sqlRef(entity);
  if (/^"?(qh|qm|qd)"?./.test(e)) throw new Error(`Alias taken inside csamQueueHeldText: ${e}`);
  return `(
    EXISTS (SELECT 1 FROM "TextScanHold" qh
      WHERE qh."entityType" = '${entityType}' AND qh."entityId" = ${e}
        AND ${liveCsamTextHoldText('qh')})
    OR EXISTS (SELECT 1 FROM "EntityModeration" qm
      WHERE qm."entityType" = '${entityType}' AND qm."entityId" = ${e}
        AND qm."status" = 'Succeeded' AND 'csam' = ANY(qm."triggeredLabels")
        AND NOT EXISTS (SELECT 1 FROM "TextScanHold" qd
          WHERE qd."entityType" = '${entityType}' AND qd."entityId" = ${e}
            AND qd."label" = 'csam' AND qd."status" = 'Dismissed'
            AND qd."textHash" = qm."result"->>'textHash'
            AND qd."meta"->>'decision' IS DISTINCT FROM 'superseded'))
  )`;
}
/** Ban reason codes that always remove the owner's media: the minor-safety bans. */
export const BAN_REASONS_ALWAYS_REMOVING_MEDIA = [
  'SexualMinor',
  'SexualMinorGenerator',
  'SexualMinorTraining',
] as const;
/**
 * The `CsamReport.details` key written once a sent report's evidence copy has been verified. Absent
 * until that verification exists; `archivedAt` alone does not confirm a verified copy.
 */
export const EVIDENCE_VERIFIED_KEY = 'evidenceVerifiedAt';

/** Report `report` (an alias) has a verified evidence copy. */
export function evidenceVerifiedText(report: string): string {
  return `COALESCE((${sqlRef(
    report
  )}.details ->> '${EVIDENCE_VERIFIED_KEY}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T', false)`;
}

/** Report `report` names `user` as its subject or its secondary user. */
export function reportNamesText(report: string, user: string): string {
  const c = sqlRef(report);
  const u = sqlRef(user);
  return `(${c}."userId" = ${u} OR ${c}.details ->> 'secondaryUserId' = (${u})::text)`;
}

/**
 * `user` has an active hold marker, or is named on a CSAM report that is unsent, or sent without a
 * verified evidence copy. Names the "EvidenceHeldUser" view, so a database without it fails the
 * statement.
 */
export function ownerHeldText(user: string): string {
  const u = sqlRef(user);
  return `(EXISTS (SELECT 1 FROM "EvidenceHeldUser" WHERE "userId" = ${u}) OR EXISTS (
    SELECT 1 FROM "CsamReport" hc WHERE ${reportNamesText('hc', u)}
      AND (hc."reportSentAt" IS NULL OR NOT ${evidenceVerifiedText('hc')})
  ))`;
}

/** `user` is named on any CSAM report. */
export function ownerReportedText(user: string): string {
  return `EXISTS (SELECT 1 FROM "CsamReport" rc WHERE ${reportNamesText('rc', user)})`;
}

/**
 * A sent report with a verified evidence copy covers image `image` of `user`: it names the user and
 * lists the image's id. A report releases only the images it covers.
 */
export function imageCoveredText(image: string, user: string): string {
  const i = sqlRef(image);
  return `EXISTS (
    SELECT 1 FROM "CsamReport" cc
    WHERE ${reportNamesText('cc', user)}
      AND cc."reportSentAt" IS NOT NULL AND ${evidenceVerifiedText('cc')}
      AND cc.images @> jsonb_build_array(jsonb_build_object('id', ${i}))
  )`;
}

/**
 * Whether any image row, moderator delete or shop takedown on the url `url` (a column reference) is
 * held, by the rule cdn-access applies: such a url is never retracted, and the moderator app's
 * retracted-media route never serves it through the CDN-refusal leg.
 * - An image: flagged for CSAM review, or its owner held, or, unless a verified report covers it, its
 *   owner named on any report, its post removed by a csam hold, or its model or version unpublished
 *   as `mature-underage`.
 * - A moderator delete: no owner recorded, the owner held, or, unless a report covers it, a CSAM
 *   review flag at deletion or an owner named on any report.
 * - A shop takedown: no owner recorded, or the owner held or named on any report.
 * An unreadable fact fails the statement rather than reading as not held.
 * With `matureUnderage: false` a `mature-underage` unpublish alone does not hold: it takes the
 * media off the site but does not limit which moderators may view it.
 */
export function heldUrlSql(
  url: string,
  {
    exceptImageId,
    matureUnderage = true,
  }: { exceptImageId?: string; matureUnderage?: boolean } = {}
): string {
  const u = sqlRef(url);
  const except = exceptImageId ? ` AND hx.id <> ${sqlRef(exceptImageId)}` : '';
  const taken = /^"?(hx|hp|hmv|hmo|hd|ht|hc|rc|cc)"?\./;
  for (const ref of [u, exceptImageId ? sqlRef(exceptImageId) : ''])
    if (taken.test(ref)) throw new Error(`Alias taken inside heldUrlSql: ${ref}`);
  const minorRemoval = matureUnderage
    ? `
          OR COALESCE(hmv.meta ->> 'unpublishedReason' = '${MATURE_UNDERAGE_REASON}', false)
          OR COALESCE(hmo.meta ->> 'unpublishedReason' = '${MATURE_UNDERAGE_REASON}', false)`
    : '';
  return `(
    EXISTS (
      SELECT 1 FROM "Image" hx
      LEFT JOIN "Post" hp ON hp.id = hx."postId"
      LEFT JOIN "ModelVersion" hmv ON hmv.id = hp."modelVersionId"
      LEFT JOIN "Model" hmo ON hmo.id = hmv."modelId"
      WHERE hx.url = ${u}${except} AND (
        hx."needsReview" IS NOT DISTINCT FROM 'csam'
        OR ${ownerHeldText('hx."userId"')}
        OR (NOT ${imageCoveredText('hx."id"', 'hx."userId"')} AND (
          ${ownerReportedText('hx."userId"')}
          OR COALESCE(hp.metadata ->> 'unpublishedReason' = '${CSAM_HOLD_POST_UNPUBLISH_REASON}', false)${minorRemoval}
        ))
      )
    )
    OR EXISTS (
      SELECT 1 FROM "ImageCdnModeratorDelete" hd
      WHERE hd.url = ${u} AND (
        hd."userId" IS NULL
        OR ${ownerHeldText('hd."userId"')}
        OR (NOT ${imageCoveredText('hd."imageId"', 'hd."userId"')}
          AND (hd."csamReview" OR ${ownerReportedText('hd."userId"')}))
      )
    )
    OR EXISTS (
      SELECT 1 FROM "ImageCdnShopTakedown" ht
      WHERE ht.url = ${u} AND (
        ht."userId" IS NULL
        OR ${ownerHeldText('ht."userId"')}
        OR ${ownerReportedText('ht."userId"')}
      )
    )
  )`;
}

/** The ids `CSAM_REPORT_LISTED_IMAGE_IDS_SQL` lists, as bigints, so a join on "Image".id can use its
 *  primary key. An entry that is not a number lists nothing. */
// The CASE, not a WHERE: Postgres may run the cast before a WHERE's pattern test.
const LISTED_IMAGE_IDS_SQL = `SELECT CASE WHEN rl_ids.id ~ '^[0-9]{1,18}$' THEN (rl_ids.id)::bigint END
  FROM (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL}) rl_ids`;

/**
 * Whether the url `url` (a column reference) carries bytes under an evidence hold: an image row on
 * it, or a moderator delete of one, is held. Bytes are per url, so a copy row is held with it.
 */
export function evidenceHeldUrlSql(url: string): string {
  const u = sqlRef(url);
  if (/^eh_/.test(u)) throw new Error(`Alias taken inside evidenceHeldUrlSql: ${u}`);
  return `(
    EXISTS (
      SELECT 1 FROM "EvidenceHoldImage" eh_h JOIN "Image" eh_i ON eh_i.id = eh_h."imageId"
      WHERE eh_i.url = ${u}
    )
    OR EXISTS (
      SELECT 1 FROM "EvidenceHoldImage" eh_h
      JOIN "ImageCdnModeratorDelete" eh_d ON eh_d."imageId" = eh_h."imageId"
      WHERE eh_d.url = ${u}
    )
  )`;
}

/**
 * Whether the url `url` (a column reference) carries reported bytes: an image row or moderator delete
 * on it is listed on any CsamReport, whatever the report's state, or an image row on it has the pHash
 * of a listed image. A copy under another url counts through its pHash only.
 */
export function reportListedUrlSql(url: string): string {
  const u = sqlRef(url);
  if (/^rl_/.test(u)) throw new Error(`Alias taken inside reportListedUrlSql: ${u}`);
  return `(
    EXISTS (SELECT 1 FROM "Image" rl_i WHERE rl_i.url = ${u} AND rl_i.id IN (${LISTED_IMAGE_IDS_SQL}))
    OR EXISTS (
      SELECT 1 FROM "ImageCdnModeratorDelete" rl_d
      WHERE rl_d.url = ${u} AND rl_d."imageId" IN (${LISTED_IMAGE_IDS_SQL})
    )
    OR EXISTS (
      SELECT 1 FROM "Image" rl_p
      -- ARRAY(...) is uncorrelated, so it is computed once per statement, not per outer row.
      WHERE rl_p.url = ${u} AND rl_p."pHash" = ANY(ARRAY(
        SELECT rl_x."pHash" FROM "Image" rl_x
        WHERE rl_x.id IN (${LISTED_IMAGE_IDS_SQL}) AND rl_x."pHash" IS NOT NULL
      ))
    )
  )`;
}

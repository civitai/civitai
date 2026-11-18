import { sqlRef } from './held-media';

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
 */
export function heldUrlSql(url: string): string {
  const u = sqlRef(url);
  if (/^(hx|hp|hmv|hmo|hd|ht|hc|rc|cc)\./.test(u))
    throw new Error(`Alias taken inside heldUrlSql: ${u}`);
  return `(
    EXISTS (
      SELECT 1 FROM "Image" hx
      LEFT JOIN "Post" hp ON hp.id = hx."postId"
      LEFT JOIN "ModelVersion" hmv ON hmv.id = hp."modelVersionId"
      LEFT JOIN "Model" hmo ON hmo.id = hmv."modelId"
      WHERE hx.url = ${u} AND (
        hx."needsReview" IS NOT DISTINCT FROM 'csam'
        OR ${ownerHeldText('hx."userId"')}
        OR (NOT ${imageCoveredText('hx."id"', 'hx."userId"')} AND (
          ${ownerReportedText('hx."userId"')}
          OR COALESCE(hp.metadata ->> 'unpublishedReason' = '${CSAM_HOLD_POST_UNPUBLISH_REASON}', false)
          OR COALESCE(hmv.meta ->> 'unpublishedReason' = '${MATURE_UNDERAGE_REASON}', false)
          OR COALESCE(hmo.meta ->> 'unpublishedReason' = '${MATURE_UNDERAGE_REASON}', false)
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

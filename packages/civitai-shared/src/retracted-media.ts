import { reviewSuspectImageSql } from './held-media';

/**
 * Blocked images served to moderators from storage, for when the public CDN no longer serves them,
 * by the main app's `/api/mod/retracted-media`. In a shared package so a moderator-app route runs the
 * same rules.
 */

/** The block reasons this path serves. Any other reason is not served, nor is a block with none. */
export const RETRACTED_MEDIA_REASONS = ['tos', 'moderated', 'Moderated', 'AiNotVerified'] as const;

/** The flag the route reads; off, it answers 403. */
export const RETRACTED_MEDIA_FLIPT_KEY = 'mod-retracted-media';

/** The mod-activity name recorded for every response that carries bytes, ranges included. */
export const RETRACTED_SERVED_ACTIVITY = 'retractedMedia:view';

/** Per moderator, per minute. */
export const RETRACTED_MEDIA_RATE_LIMIT = 600;

/** The largest object served; a larger one is refused whole, ranges included. */
export const RETRACTED_MEDIA_MAX_BYTES = 250 * 1024 * 1024;

/** How long one response may stream before it is cut off. */
export const RETRACTED_MEDIA_STREAM_MS = 5 * 60_000;

/**
 * Whether the "Image" row aliased `image` may be served here. Never true for a row carrying a CSAM or
 * minor signal (`reviewSuspectImageSql`, which covers everything `heldImageSql` holds, so each image is
 * servable by at most one of this route and `/api/held-media`), nor for an image under an evidence
 * hold or whose owner is named on any CsamReport or held, whatever the block reason.
 */
export function retractedImageSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  const i = image;
  const owner = `${i}."userId"`;
  const reasons = RETRACTED_MEDIA_REASONS.map((r) => `'${r}'`).join(', ');
  return `(
    ${i}.ingestion = 'Blocked'
    AND ${i}."blockedFor" IS NOT NULL AND ${i}."blockedFor" IN (${reasons})
    AND NOT EXISTS (SELECT 1 FROM "EvidenceHoldImage" rh WHERE rh."imageId" = ${i}.id)
    AND NOT EXISTS (SELECT 1 FROM "EvidenceHeldUser" ru WHERE ru."userId" = ${owner})
    AND NOT EXISTS (SELECT 1 FROM "CsamReport" rr WHERE rr."userId" = ${owner})
    AND NOT EXISTS (
      SELECT 1 FROM "CsamReport" rs
      WHERE CASE WHEN rs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
                 THEN (rs.details ->> 'secondaryUserId')::bigint END = ${owner}
    )
    AND NOT ${reviewSuspectImageSql(i)}
  )`;
}

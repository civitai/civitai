import { heldImageSql } from './held-media';

/**
 * Blocked images served to moderators from storage, for when the public CDN no longer serves them,
 * by the main app's `/api/mod/retracted-media`. In a shared package so a moderator-app route runs the
 * same rules.
 */

/** The block reasons this path serves. Any other reason is not served. */
export const RETRACTED_MEDIA_REASONS = ['tos', 'moderated', 'Moderated', 'AiNotVerified'] as const;

/** Browsing levels at which a minor-flagged image is still served: PG and PG-13. */
const MINOR_SERVABLE_LEVELS = [1, 2];

/** The flag both routes read; off, both answer 403. */
export const RETRACTED_MEDIA_FLIPT_KEY = 'mod-retracted-media';

/** The mod-activity name of one served response from byte 0. */
export const RETRACTED_SERVED_ACTIVITY = 'retractedMedia:view';

/** Per moderator, per minute. */
export const RETRACTED_MEDIA_RATE_LIMIT = 600;

/** The largest object served; a larger one is refused whole, ranges included. */
export const RETRACTED_MEDIA_MAX_BYTES = 250 * 1024 * 1024;

/** How long one response may stream before it is cut off. */
export const RETRACTED_MEDIA_STREAM_MS = 5 * 60_000;

/**
 * Whether the "Image" row aliased `image` may be served here. Never true for a row `heldImageSql`
 * holds, so each image is servable by at most one of this route and `/api/held-media`, and never for
 * an image or owner named on any CsamReport or under an evidence hold, whatever the block reason.
 */
export function retractedImageSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  const i = image;
  const owner = `${i}."userId"`;
  const reasons = RETRACTED_MEDIA_REASONS.map((r) => `'${r}'`).join(', ');
  const levels = MINOR_SERVABLE_LEVELS.join(', ');
  return `(
    ${i}.ingestion = 'Blocked'
    AND (${i}."blockedFor" IS NULL OR ${i}."blockedFor" IN (${reasons}))
    AND ((${i}."needsReview" IS DISTINCT FROM 'minor' AND ${i}.minor IS NOT TRUE)
      OR ${i}."nsfwLevel" IN (${levels}))
    AND NOT EXISTS (SELECT 1 FROM "EvidenceHoldImage" rh WHERE rh."imageId" = ${i}.id)
    AND NOT EXISTS (SELECT 1 FROM "EvidenceHeldUser" ru WHERE ru."userId" = ${owner})
    AND NOT EXISTS (SELECT 1 FROM "CsamReport" rr WHERE rr."userId" = ${owner})
    AND NOT EXISTS (
      SELECT 1 FROM "CsamReport" rs
      WHERE CASE WHEN rs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
                 THEN (rs.details ->> 'secondaryUserId')::bigint END = ${owner}
    )
    AND NOT EXISTS (
      SELECT 1 FROM "CsamReport" rl
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(rl.images) = 'array' THEN rl.images ELSE '[]'::jsonb END
      ) le
      WHERE CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END
        = (${i}.id)::text
    )
    -- Covers a csam review flag. IS NOT TRUE, not NOT: the fragment is NULL for a row with no
    -- review flag.
    AND ${heldImageSql(i)} IS NOT TRUE
  )`;
}

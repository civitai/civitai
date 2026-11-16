import { heldImageSql, heldUserSql, reviewSuspectImageSql } from './held-media';
import { blockedForSignal, type BlockedForPatterns } from './review-batch';

/**
 * Who may see a blocked image on this route:
 * - `plain`: any moderator.
 * - `suspect`: only moderators cleared for CSAM review, for an image carrying a CSAM or minor signal,
 *   a block with no reason or a reason `blockedForSignal` reads as a signal, or an owner named on a
 *   report or held.
 * Held media (`heldImageSql`) and an image under an evidence hold are never served here; the
 * held-media route serves the first.
 */
export type RetractedTier = 'plain' | 'suspect';

/** Whether this route may serve the "Image" row aliased `image` at all, to anyone: it is blocked,
 *  not held media, and not under an evidence hold. */
export function retractedImageWhereSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  return `(
    ${image}.ingestion = 'Blocked'
    -- NULL for an image with no review flag or block reason, so COALESCE before the NOT.
    AND NOT COALESCE(${heldImageSql(image)}, false)
    AND NOT EXISTS (SELECT 1 FROM "EvidenceHoldImage" rh WHERE rh."imageId" = ${image}.id)
  )`;
}

/** Whether the "Image" row aliased `image` has a signal that puts it in the `suspect` tier, read in
 *  Postgres. `blockedFor` text is read by `retractedTier` against the private patterns. */
export function retractedSuspectSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  return `COALESCE((
    ${image}."blockedFor" IS NULL
    OR ${reviewSuspectImageSql(image)}
    OR ${heldUserSql(`${image}."userId"`)}
  ), false)`;
}

export function retractedTier(
  row: { suspect: boolean; blockedFor: string | null },
  patterns: BlockedForPatterns | null
): RetractedTier {
  return row.suspect || blockedForSignal(row.blockedFor, patterns) ? 'suspect' : 'plain';
}

import { heldImageSql, heldUserSql, reviewSuspectImageSql } from './held-media';
import { BAN_REASONS_ALWAYS_REMOVING_MEDIA, heldUrlSql, MINOR_UNPUBLISH_REASONS } from './held-url';
import { blockedForSignal, type BlockedForPatterns } from './review-batch';

/**
 * Who may see a blocked image on this route:
 * - `plain`: any moderator.
 * - `suspect`: only moderators cleared for CSAM review, for an image carrying a CSAM or minor signal,
 *   a block with no reason or a reason `blockedForSignal` reads as a signal, or an owner named on a
 *   report or held.
 * Held media (`heldImageSql`) and an image under an evidence hold are never served here; the
 * held-media route serves the first. With `cdnLeg`, a scanned image is also eligible while the image
 * CDN has retracted its url, unless the url is held (`heldUrlSql`) or another image row, a moderator
 * delete or a shop takedown shares it.
 */
export type RetractedTier = 'plain' | 'suspect';

/** Whether this route may serve the "Image" row aliased `image` at all, to anyone: it is blocked
 *  (or, with `cdnLeg`, scanned with its url retracted and not held), not held media, and not under
 *  an evidence hold. */
export function retractedImageWhereSql(image: string, { cdnLeg = false } = {}): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  const eligible = cdnLeg
    ? `(${image}.ingestion = 'Blocked' OR (
      ${image}.ingestion = 'Scanned'
      AND EXISTS (
        SELECT 1 FROM "ImageCdnAccess" ca WHERE ca.url = ${image}."url" AND ca.state = 'Retracted'
      )
      AND NOT ${heldUrlSql(`${image}."url"`)}
      -- Bytes are per url, the tier per row: another row's signal would not reach this one, so the
      -- url must be this row's alone, with no deleted or taken-down copy behind it either.
      AND NOT EXISTS (SELECT 1 FROM "Image" so WHERE so.url = ${image}."url" AND so.id <> ${image}.id)
      AND NOT EXISTS (SELECT 1 FROM "ImageCdnModeratorDelete" sd WHERE sd.url = ${image}."url")
      AND NOT EXISTS (SELECT 1 FROM "ImageCdnShopTakedown" st WHERE st.url = ${image}."url")
    ))`
    : `${image}.ingestion = 'Blocked'`;
  return `(
    ${eligible}
    -- NULL for an image with no review flag or block reason, so COALESCE before the NOT.
    AND NOT COALESCE(${heldImageSql(image)}, false)
    AND NOT EXISTS (SELECT 1 FROM "EvidenceHoldImage" rh WHERE rh."imageId" = ${image}.id)
  )`;
}

/** Whether the "Image" row aliased `image` has a signal that puts it in the `suspect` tier, read in
 *  Postgres. `blockedFor` text is read by `retractedTier` against the private patterns. */
export function retractedSuspectSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  const minorReasons = MINOR_UNPUBLISH_REASONS.map((r) => `'${r}'`).join(', ');
  const minorBans = BAN_REASONS_ALWAYS_REMOVING_MEDIA.map((r) => `'${r}'`).join(', ');
  return `COALESCE((
    -- A block with no reason. An image that is not blocked has no reason by construction.
    (${image}."blockedFor" IS NULL AND ${image}.ingestion = 'Blocked')
    OR ${reviewSuspectImageSql(image)}
    OR ${heldUserSql(`${image}."userId"`)}
    -- A scanned image is here only because its url was retracted: a minor reason on its post or
    -- model, or a minor-safety ban of its owner, is a signal that its own flags may not carry.
    OR (${image}.ingestion = 'Scanned' AND (
      EXISTS (
        SELECT 1 FROM "Post" sp
        LEFT JOIN "ModelVersion" smv ON smv.id = sp."modelVersionId"
        LEFT JOIN "Model" smo ON smo.id = smv."modelId"
        WHERE sp.id = ${image}."postId" AND (
          sp.metadata ->> 'unpublishedReason' IN (${minorReasons})
          OR smv.meta ->> 'unpublishedReason' IN (${minorReasons})
          OR smo.meta ->> 'unpublishedReason' IN (${minorReasons})
        )
      )
      OR EXISTS (
        SELECT 1 FROM "User" su
        WHERE su.id = ${image}."userId" AND su.meta -> 'banDetails' ->> 'reasonCode' IN (${minorBans})
      )
    ))
  ), false)`;
}

export function retractedTier(
  row: { suspect: boolean; blockedFor: string | null },
  patterns: BlockedForPatterns | null
): RetractedTier {
  return row.suspect || blockedForSignal(row.blockedFor, patterns) ? 'suspect' : 'plain';
}

export type ScannerVerdict = 'hit' | 'clear' | 'none';

/**
 * A process-local cache of scanner verdicts, so a page of tiles, or a video's range requests, does
 * not query ClickHouse once per request. A blocked image's labels are written by its scan, which has
 * finished, so a verdict held for `ttlMs` is not expected to go stale. An unreadable answer (null) is
 * never cached: the next request asks again.
 */
export function createScannerVerdictCache(
  read: (imageId: number) => Promise<ScannerVerdict | null>,
  { ttlMs = 5 * 60_000, max = 10_000, now = () => Date.now() } = {}
) {
  const entries = new Map<number, { verdict: ScannerVerdict; at: number }>();
  return {
    async read(imageId: number): Promise<ScannerVerdict | null> {
      const hit = entries.get(imageId);
      if (hit && now() - hit.at < ttlMs) return hit.verdict;
      entries.delete(imageId);
      const verdict = await read(imageId);
      if (verdict === null) return null;
      if (entries.size >= max) entries.delete(entries.keys().next().value as number);
      entries.set(imageId, { verdict, at: now() });
      return verdict;
    },
    clear: () => entries.clear(),
  };
}

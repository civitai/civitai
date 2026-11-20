import { CSAM_REPORT_LISTED_IMAGE_IDS_SQL, heldImageSql, heldUserSql } from './held-media';
import {
  BAN_REASONS_ALWAYS_REMOVING_MEDIA,
  CSAM_HOLD_POST_UNPUBLISH_REASON,
  evidenceHeldUrlSql,
  heldUrlSql,
  reportListedUrlSql,
} from './held-url';

/** Whether the retracted-media routes may serve the "Image" row aliased `image` at all, to anyone:
 *  it is blocked (or, with `cdnLeg`, scanned with its url retracted or denied and not held), not held media
 *  (`heldImageSql`, which the held-media route serves), and not under an evidence hold. With
 *  `cdnLeg`, the url must also be the row's alone. Who among moderators may see it is
 *  `csamRestrictedSql`'s call. */
export function retractedImageWhereSql(image: string, { cdnLeg = false } = {}): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  const eligible = cdnLeg
    ? `(${image}.ingestion = 'Blocked' OR (
      ${image}.ingestion = 'Scanned'
      AND EXISTS (
        SELECT 1 FROM "ImageCdnAccess" ca
        WHERE ca.url = ${image}."url" AND ca.state IN ('Retracted', 'Denied')
      )
      AND NOT ${heldUrlSql(`${image}."url"`)}
      -- Bytes are per url, the checks per row: another row's signal would not reach this one, so the
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

/**
 * Whether the "Image" row aliased `image` is kept to moderators cleared for CSAM review: marked as
 * CSAM (in the CSAM queue, blocked as CSAM, a CSAM hash, a CSAM scan flag, hold or vote), listed on a
 * CSAM report, its owner reported, held or banned for minor safety, blocked with no reason, or its
 * bytes (by url or pHash copy) reported, held or under an evidence hold. A minor signal alone is not
 * here: any moderator may see it. `blockedFor` text and the scanner's labels are read by the caller.
 */
export function csamRestrictedSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  const id = `${image}.id`;
  const url = `${image}."url"`;
  const minorBans = BAN_REASONS_ALWAYS_REMOVING_MEDIA.map((r) => `'${r}'`).join(', ');
  return `COALESCE((
    COALESCE(${heldImageSql(image)}, false)
    OR (${image}."blockedFor" IS NULL AND ${image}.ingestion = 'Blocked')
    OR EXISTS (SELECT 1 FROM "BlockedImage" cb WHERE cb.hash = ${image}."pHash" AND cb.reason = 'CSAM')
    OR EXISTS (
      SELECT 1 FROM "ScanLabelItem" ci
      WHERE ci."imageId" = ${id} AND (
        ci."voidReason" = 'csam-hold'
        OR EXISTS (
          SELECT 1 FROM "ScanLabelFlag" cf WHERE cf."itemId" = ci.id AND cf.snapshot ->> 'csam' = 'true'
        )
        OR EXISTS (
          SELECT 1 FROM "ScanLabelVote" cv WHERE cv."itemId" = ci.id AND cv.reason = 'csam-realistic'
        )
      )
    )
    OR (${id})::text IN (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL})
    OR EXISTS (
      SELECT 1 FROM "User" cu
      WHERE cu.id = ${image}."userId" AND cu.meta -> 'banDetails' ->> 'reasonCode' IN (${minorBans})
    )
    OR ${reportListedUrlSql(url)}
    OR ${evidenceHeldUrlSql(url)}
    -- The url's other rows by the held-url rule; this row by its owner, its post's CSAM reason, and
    -- any CSAM text hold on its post or model that is not dismissed.
    OR ${heldUrlSql(url, { exceptImageId: `${image}."id"` })}
    OR ${heldUserSql(`${image}."userId"`)}
    OR EXISTS (
      SELECT 1 FROM "Post" cp
      WHERE cp.id = ${image}."postId" AND cp.metadata ->> 'unpublishedReason' = '${CSAM_HOLD_POST_UNPUBLISH_REASON}'
    )
    OR EXISTS (
      SELECT 1 FROM "TextScanHold" cph
      WHERE cph."entityType" = 'Post' AND cph."entityId" = ${image}."postId"
        AND cph.label = 'csam' AND cph.status <> 'Dismissed'
    )
    OR EXISTS (
      SELECT 1 FROM "Post" cmp
      JOIN "ModelVersion" cmv ON cmv.id = cmp."modelVersionId"
      JOIN "TextScanHold" cth ON cth."entityType" = 'Model' AND cth."entityId" = cmv."modelId"
      WHERE cmp.id = ${image}."postId" AND cth.label = 'csam' AND cth.status <> 'Dismissed'
    )
  ), true)`;
}

export type ScannerVerdict = 'hit' | 'clear' | 'none';

/**
 * A process-local cache of scanner verdicts, so a page of tiles, or a video's range requests, does
 * not query ClickHouse once per request. A blocked image's labels are written by its scan, which has
 * finished, so a `hit` or `clear` held for `ttlMs` is not expected to go stale. An unreadable answer
 * (null) and `none` are never cached: rows can land after the verdict, so the next request asks again.
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
      if (verdict === null || verdict === 'none') return verdict;
      if (entries.size >= max) entries.delete(entries.keys().next().value as number);
      entries.set(imageId, { verdict, at: now() });
      return verdict;
    },
    clear: () => entries.clear(),
  };
}

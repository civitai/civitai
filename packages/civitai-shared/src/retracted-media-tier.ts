import {
  CSAM_REPORT_LISTED_IMAGE_IDS_SQL,
  heldImageSql,
  heldUserSql,
  unreadableImageSql,
} from './held-media';
import {
  BAN_REASONS_ALWAYS_REMOVING_MEDIA,
  CSAM_HOLD_POST_UNPUBLISH_REASON,
  evidenceHeldUrlSql,
  heldUrlSql,
  liveCsamTextHoldText,
  reportListedUrlSql,
} from './held-url';

/** Whether the retracted-media routes may serve the "Image" row aliased `image` at all, to anyone:
 *  it is blocked (or, with `cdnLeg`, scanned with its url retracted and not held), not held media
 *  (`heldImageSql`, which the held-media route serves), and not under an evidence hold. With
 *  `cdnLeg`, the url must also be the row's alone. Who among moderators may see it is
 *  `csamRestrictedSql`'s call. */
export function retractedImageWhereSql(image: string, { cdnLeg = false } = {}): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  const eligible = cdnLeg
    ? `(${image}.ingestion = 'Blocked' OR (
      ${image}.ingestion = 'Scanned'
      AND EXISTS (
        SELECT 1 FROM "ImageCdnAccess" ca WHERE ca.url = ${image}."url" AND ca.state = 'Retracted'
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

/** At most this many other rows on a url are read; a url with more is refused (`siblingsServable`). */
export const URL_SIBLING_CAP = 50;

/**
 * The CSAM signals read off one "Image" row aliased `image`: marked as CSAM (in the CSAM queue,
 * blocked as CSAM, a CSAM hash, a CSAM scan flag, hold or vote), blocked with no reason, its owner
 * reported, held or banned for minor safety, its post removed by a CSAM hold, or a CSAM text hold
 * that is not dismissed on its post, its post's text, its model, an article it is in, or a service
 * offering or profile it is the cover of.
 */
function csamRowSql(image: string): string {
  const id = `${image}.id`;
  const minorBans = BAN_REASONS_ALWAYS_REMOVING_MEDIA.map((r) => `'${r}'`).join(', ');
  return `(
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
    OR EXISTS (
      SELECT 1 FROM "User" cu
      WHERE cu.id = ${image}."userId" AND cu.meta -> 'banDetails' ->> 'reasonCode' IN (${minorBans})
    )
    OR ${heldUserSql(`${image}."userId"`)}
    OR EXISTS (
      SELECT 1 FROM "Post" cp
      WHERE cp.id = ${image}."postId" AND cp.metadata ->> 'unpublishedReason' = '${CSAM_HOLD_POST_UNPUBLISH_REASON}'
    )
    OR EXISTS (
      SELECT 1 FROM "TextScanHold" cph
      WHERE cph."entityType" = 'Post' AND cph."entityId" = ${image}."postId" AND ${liveCsamTextHoldText(
    'cph'
  )}
    )
    OR EXISTS (
      SELECT 1 FROM "PostText" cpt
      WHERE cpt."postId" = ${image}."postId" AND (cpt."csamHeld" OR EXISTS (
        SELECT 1 FROM "TextScanHold" cpth
        WHERE cpth."entityType" = 'PostText' AND cpth."entityId" = cpt.id AND ${liveCsamTextHoldText(
          'cpth'
        )}
      ))
    )
    OR EXISTS (
      SELECT 1 FROM "Post" cmp
      JOIN "ModelVersion" cmv ON cmv.id = cmp."modelVersionId"
      JOIN "TextScanHold" cth ON cth."entityType" = 'Model' AND cth."entityId" = cmv."modelId"
      WHERE cmp.id = ${image}."postId" AND ${liveCsamTextHoldText('cth')}
    )
    OR EXISTS (
      SELECT 1 FROM "TextScanHold" cah
      WHERE cah."entityType" = 'Article' AND ${liveCsamTextHoldText('cah')} AND cah."entityId" IN (
        SELECT ca.id FROM "Article" ca WHERE ca."coverId" = ${id} OR ca."bannerId" = ${id}
        UNION ALL
        SELECT cic."entityId" FROM "ImageConnection" cic
        WHERE cic."imageId" = ${id} AND cic."entityType" = 'Article'
      )
    )
    OR EXISTS (
      SELECT 1 FROM "ServiceOffering" cso
      JOIN "TextScanHold" csoh ON csoh."entityType" = 'ServiceOffering' AND csoh."entityId" = cso.id
      WHERE cso."coverImageId" = ${id} AND ${liveCsamTextHoldText('csoh')}
    )
    OR EXISTS (
      SELECT 1 FROM "TextScanHold" cuph
      JOIN "UserProfile" cup ON cup."userId" = cuph."entityId"
      WHERE cuph."entityType" = 'UserProfile' AND ${liveCsamTextHoldText('cuph')}
        AND (cup."coverImageId" = ${id} OR cup."sfwCoverImageId" = ${id})
    )
  )`;
}

/**
 * Whether the "Image" row aliased `image` is kept to moderators cleared for CSAM review: it, or
 * one of the first `URL_SIBLING_CAP` other rows on its url, carries a CSAM signal in Postgres (`csamRowSql`); it is listed on a CSAM
 * report; or its bytes (by url or pHash copy) are reported, held or under an evidence hold. A minor
 * signal alone is not here: any moderator may see it. `blockedFor` text and the scanner's labels,
 * of this row and of `urlSiblingsSql`'s rows, are read by the caller (`siblingsServable`).
 */
export function csamRestrictedSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image) || CSAM_RESTRICTED_ALIASES.has(image.toLowerCase()))
    throw new Error(`Bad table alias: ${image}`);
  return buildCsamRestrictedSql(image);
}

function buildCsamRestrictedSql(image: string): string {
  const id = `${image}.id`;
  const url = `${image}."url"`;
  const sibling = csamRowSql('cs');
  return `COALESCE((
    ${csamRowSql(image)}
    OR EXISTS (
      SELECT 1 FROM (
        SELECT * FROM "Image" cs WHERE cs.url = ${url} AND cs.id <> ${id} LIMIT ${URL_SIBLING_CAP}
      ) cs
      WHERE COALESCE(${sibling}, true)
    )
    OR (${id})::text IN (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL})
    OR ${reportListedUrlSql(url)}
    OR ${evidenceHeldUrlSql(url)}
    OR ${heldUrlSql(url, { exceptImageId: `${image}."id"` })}
  ), true)`;
}

/** The aliases `csamRestrictedSql` declares after a quoted table name, which its caller's alias must
 *  not shadow. */
const CSAM_RESTRICTED_ALIASES = new Set(
  [...buildCsamRestrictedSql('i').matchAll(/(?:FROM|JOIN) "\w+" (\w+)/g)].map((m) =>
    m[1].toLowerCase()
  )
);

export type UrlSibling = { id: number; blockedFor: string | null; unreadable: boolean };

/**
 * The other "Image" rows on the url of the row aliased `image`, as a JSON array of
 * `UrlSibling`, at most `URL_SIBLING_CAP` of them.
 */
export function urlSiblingsSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image) || image.toLowerCase() === 'us')
    throw new Error(`Bad table alias: ${image}`);
  return `COALESCE((
    SELECT json_agg(json_build_object(
      'id', us.id, 'blockedFor', us."blockedFor", 'unreadable', ${unreadableImageSql('us')}
    )) FROM (
      SELECT us.id, us."blockedFor", us.ingestion FROM "Image" us
      WHERE us.url = ${image}."url" AND us.id <> ${image}.id
      LIMIT ${URL_SIBLING_CAP}
    ) us
  ), '[]'::json)`;
}

/**
 * Whether no row in `siblings` (`urlSiblingsSql`) keeps the shared url from a moderator without the
 * CSAM grant: the list is under `URL_SIBLING_CAP`, every row has finished its scan, `isSignal`
 * holds for no row's `blockedFor`, and, when `readVerdicts` is given, the scanner marks none. An
 * unreadable scanner refuses.
 */
export async function siblingsServable(
  siblings: UrlSibling[],
  isSignal: (blockedFor: string | null) => boolean,
  readVerdicts?: (imageIds: number[]) => Promise<Map<number, ScannerVerdict> | null>
): Promise<boolean> {
  if (siblings.length >= URL_SIBLING_CAP) return false;
  if (siblings.some((s) => s.unreadable !== false || isSignal(s.blockedFor))) return false;
  if (!readVerdicts || !siblings.length) return true;
  const verdicts = await readVerdicts(siblings.map((s) => s.id));
  if (!verdicts) return false;
  return siblings.every((s) => {
    const v = verdicts.get(s.id);
    return v === 'clear' || v === 'none';
  });
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

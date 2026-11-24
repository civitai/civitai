import {
  CSAM_REPORT_LISTED_IMAGE_IDS_SQL,
  csamSignalImageSql,
  heldImageKnownSql,
  heldImageSql,
  heldItemImageSql,
  unreadableImageSql,
} from './held-media';
import { evidenceHeldUrlSql, heldUrlSql, reportListedUrlSql } from './held-url';
import { blockedForSignal, type BlockedForPatterns, type ScannerVerdict } from './media-signals';

/** Whether the retracted-media routes may serve the "Image" row aliased `image` at all, to anyone:
 *  it is blocked, or scanned with its url refused by the CDN, that url the row's alone and its file
 *  not held (`heldUrlSql` with `owners: false`). Without `cdnLeg`, the refusal must come from someone
 *  other than the owner unpublishing its post, not by a delete a case keeps, and the row must carry no
 *  CSAM mark of its own. Held media (`heldImageSql`) is excluded: the held-media route and the
 *  moderator app's held leg serve it. Who among moderators may see it is `csamRestrictedSql`'s call. */
export function retractedImageWhereSql(image: string, { cdnLeg = false } = {}): string {
  return `(
    ${retractedEligibleSql(image, cdnLeg)}
    AND NOT ${heldImageKnownSql(image)}
  )`;
}

/** `retractedImageWhereSql` with held media let through unless it is held for itself
 *  (`heldItemImageSql`): a held account's image the routes would serve if it were not held. */
export function retractedOrOwnerHeldWhereSql(image: string, { cdnLeg = false } = {}): string {
  return `(
    ${retractedEligibleSql(image, cdnLeg)}
    AND NOT COALESCE(${heldItemImageSql(image)}, false)
  )`;
}

function retractedEligibleSql(image: string, cdnLeg: boolean): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  const refused = scannedRefusedSql(image);
  if (cdnLeg) return `(${image}.ingestion = 'Blocked' OR ${refused})`;
  // Without the leg, only a refusal a moderator's pull of its post explains, and no CSAM mark of
  // the row's own.
  return `(${image}.ingestion = 'Blocked' OR (
    ${refused}
    AND ${postPulledSql(image)}
    AND NOT COALESCE(${heldItemImageSql(image)}, false)
    AND NOT COALESCE(${csamSignalImageSql(image)}, false)
  ))`;
}

/** A scanned row whose url the CDN refuses, with no held file and nothing but this row behind it. */
function scannedRefusedSql(image: string): string {
  return `(
      ${image}.ingestion = 'Scanned'
      AND EXISTS (
        SELECT 1 FROM "ImageCdnAccess" ca
        WHERE ca.url = ${image}."url" AND ca.state IN ('Denied', 'Retracted')
      )
      AND NOT ${heldUrlSql(`${image}."url"`, { owners: false })}
      -- Bytes are per url, the checks per row: another row's signal would not reach this one, so the
      -- url must be this row's alone, with no deleted or taken-down copy behind it either.
      AND NOT EXISTS (SELECT 1 FROM "Image" so WHERE so.url = ${image}."url" AND so.id <> ${image}.id)
      AND NOT EXISTS (SELECT 1 FROM "ImageCdnModeratorDelete" sd WHERE sd.url = ${image}."url")
      AND NOT EXISTS (SELECT 1 FROM "ImageCdnShopTakedown" st WHERE st.url = ${image}."url")
    )`;
}

// `POST_PENDING_DELETE_REASON` in @civitai/db-queries, which imports this package.
const PENDING_DELETE_REASON = 'pending-delete';

/** Its post was unpublished by someone other than its owner, and not by a delete a case keeps: what
 *  makes cdn-access refuse a scanned image's url (`desiredPostAccess` in the main app's cdn-access
 *  service), less the kept delete, which stays refused. */
function postPulledSql(image: string): string {
  return `EXISTS (
      SELECT 1 FROM "Post" pp
      WHERE pp.id = ${image}."postId" AND pp."publishedAt" IS NULL
        AND pp.metadata ? 'unpublishedAt'
        AND pp.metadata ->> 'unpublishedBy' IS DISTINCT FROM pp."userId"::text
        AND pp.metadata ->> 'unpublishedBy' IS NOT NULL
        AND pp.metadata ->> 'unpublishedReason' IS DISTINCT FROM '${PENDING_DELETE_REASON}'
    )`;
}

/**
 * The rows a retracted-media read answers this moderator from. Any moderator gets what the routes
 * would serve were no owner held (`retractedOrOwnerHeldWhereSql`), so a held owner cannot be told
 * apart. On a route with a held leg (`heldLeg`), a moderator with the CSAM grant also gets all held
 * media, and any other moderator media held for itself, drawn as restricted.
 */
export function moderatorMediaWhereSql(
  image: string,
  {
    cdnLeg = false,
    csamReview,
    heldLeg,
  }: { cdnLeg?: boolean; csamReview: boolean; heldLeg: boolean }
): string {
  const openable = retractedOrOwnerHeldWhereSql(image, { cdnLeg });
  if (csamReview)
    return heldLeg
      ? `(${retractedImageWhereSql(image, { cdnLeg })} OR ${heldImageKnownSql(image)})`
      : openable;
  return heldLeg ? `(${openable} OR COALESCE(${heldItemImageSql(image)}, false))` : openable;
}

/** At most this many other rows on a url are read; a url with more is refused (`siblingsServable`). */
export const URL_SIBLING_CAP = 50;

/**
 * The CSAM marks read off one "Image" row aliased `image` itself: in the CSAM queue or blocked as
 * CSAM (`heldItemImageSql`), or a CSAM hash, hold, vote or, with `scanFlag`, scan flag
 * (`csamSignalImageSql`). Nothing about its owner, post, model or the entities it appears on, and no
 * minor signal, is here.
 */
function csamRowSql(image: string, scanFlag: boolean): string {
  return `(
    COALESCE(${heldItemImageSql(image)}, false)
    OR ${csamSignalImageSql(image, { scanFlag })}
  )`;
}

/**
 * Whether the "Image" row aliased `image` sits on a url retracted by an upgraded deny. An upgraded
 * deny may have capped a hold on a row since deleted, which nothing here can see, so its url stays
 * with the CSAM grant. An outright retraction stamps both times from one expression in one INSERT,
 * so they are equal; an upgrade keeps the earlier deny time. Anything but equal, NULL included,
 * reads as upgraded.
 */
export function upgradedRetractionSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image) || image.toLowerCase() === 'ua')
    throw new Error(`Bad table alias: ${image}`);
  return `(EXISTS (
    SELECT 1 FROM "ImageCdnAccess" ua WHERE ua.url = ${image}."url" AND ua.state = 'Retracted'
      AND ua."retractedAt" IS DISTINCT FROM ua."deniedAt"
  ))`;
}

/**
 * Whether the "Image" row aliased `image` is kept to moderators cleared for CSAM review: it, or
 * one of the first `URL_SIBLING_CAP` other rows on its url, carries a CSAM signal in Postgres
 * (`csamRowSql`); it is listed on a CSAM report; its bytes (by url or pHash copy) are reported, held
 * or under an evidence hold; or the file is held (`heldUrlSql` with `owners: false`). Nothing about
 * an owner, post or model is here, and neither is a minor signal alone: any moderator may see those.
 * With `scanFlag: false` a scan flag alone is not a CSAM signal either: what the moderator views use. `blockedFor`
 * text and the scanner's labels, of this row and of `urlSiblingsSql`'s rows, are read by the caller.
 */
export function csamRestrictedSql(image: string, { scanFlag = true } = {}): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image) || CSAM_RESTRICTED_ALIASES.has(image.toLowerCase()))
    throw new Error(`Bad table alias: ${image}`);
  return buildCsamRestrictedSql(image, scanFlag);
}

function buildCsamRestrictedSql(image: string, scanFlag = true): string {
  const id = `${image}.id`;
  const url = `${image}."url"`;
  const sibling = csamRowSql('cs', scanFlag);
  return `COALESCE((
    ${csamRowSql(image, scanFlag)}
    OR EXISTS (
      SELECT 1 FROM (
        SELECT * FROM "Image" cs WHERE cs.url = ${url} AND cs.id <> ${id} LIMIT ${URL_SIBLING_CAP}
      ) cs
      WHERE COALESCE(${sibling}, true)
    )
    OR (${id})::text IN (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL})
    OR ${reportListedUrlSql(url)}
    OR ${evidenceHeldUrlSql(url)}
    OR ${heldUrlSql(url, { exceptImageId: `${image}."id"`, owners: false })}
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

/** `siblingsServable` without its scanner read. */
export function siblingsClearInPostgres(
  siblings: UrlSibling[],
  isSignal: (blockedFor: string | null) => boolean
): boolean {
  return (
    siblings.length < URL_SIBLING_CAP &&
    !siblings.some((s) => s.unreadable !== false || isSignal(s.blockedFor))
  );
}

/**
 * Whether no row in `siblings` (`urlSiblingsSql`) keeps the shared url from a moderator without the
 * CSAM grant: the list is under `URL_SIBLING_CAP`, every row has finished its scan, `isSignal`
 * holds for no row's `blockedFor`, and the scanner marks none. An unreadable scanner refuses.
 */
export async function siblingsServable(
  siblings: UrlSibling[],
  isSignal: (blockedFor: string | null) => boolean,
  readVerdicts: (imageIds: number[]) => Promise<Map<number, ScannerVerdict> | null>
): Promise<boolean> {
  if (!siblingsClearInPostgres(siblings, isSignal)) return false;
  if (!siblings.length) return true;
  const verdicts = await readVerdicts(siblings.map((s) => s.id));
  if (!verdicts) return false;
  return siblings.every((s) => {
    const v = verdicts.get(s.id);
    return v === 'clear' || v === 'none';
  });
}

/**
 * The two columns a retracted-media read selects for the "Image" row aliased `image`, as SQL:
 * `restricted` (`csamRestrictedSql`, or a url retracted by an upgraded deny) and `siblings`
 * (`urlSiblingsSql`). Constants for a moderator cleared for CSAM review, who is never refused on them.
 * `scanFlag` is `csamRestrictedSql`'s.
 */
export function retractedAccessColumnsSql(
  image: string,
  { csamReview, scanFlag = true }: { csamReview: boolean; scanFlag?: boolean }
) {
  if (csamReview) return { restricted: 'false', siblings: "'[]'::json" };
  return {
    restricted: `(${csamRestrictedSql(image, { scanFlag })} OR ${upgradedRetractionSql(image)})`,
    siblings: urlSiblingsSql(image),
  };
}

export type RetractedAccessRow = {
  blockedFor: string | null;
  restricted: boolean;
  siblings: UrlSibling[];
};

/**
 * Whether a moderator without the CSAM grant may see an eligible row read with
 * `retractedAccessColumnsSql`: not restricted, no `blockedFor` signal (`blockedForSignal`, where a
 * minor reason alone is none), the scanner's CSAM label on neither the row
 * (`readVerdict`) nor its url's other rows, and `siblingsServable`. A verdict that could not be read
 * (null) refuses. The scanner is read only for a row Postgres has not refused.
 */
export async function retractedViewable(
  row: RetractedAccessRow,
  {
    patterns,
    readVerdict,
    readVerdicts,
  }: {
    patterns: BlockedForPatterns | null;
    readVerdict: () => Promise<ScannerVerdict | null>;
    readVerdicts: (imageIds: number[]) => Promise<Map<number, ScannerVerdict> | null>;
  }
): Promise<boolean> {
  const isSignal = (blockedFor: string | null) => blockedForSignal(blockedFor, patterns);
  if (row.restricted || isSignal(row.blockedFor)) return false;
  const verdict = await readVerdict();
  if (verdict !== 'clear' && verdict !== 'none') return false;
  return siblingsServable(row.siblings, isSignal, readVerdicts);
}

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

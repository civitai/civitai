import { csamInBlockedForSql } from './csam-blocked-for';

/**
 * Serving review-queue media to moderators from storage rather than the public image CDN. Shared by
 * the moderator app's `/api/held-media` and the main app's `/api/mod/held-media`, so the two routes
 * cannot disagree on what a browser is allowed to render from their origin.
 */

/** The owner `deleteUser` hands kept content to; the main app's `PLACEHOLDER_OWNER_ID`. */
const PLACEHOLDER_OWNER_ID = -1;

/** An alias (`i`) or an aliased column (`m."userId"`), checked because the SQL splices it as written. */
export function sqlRef(ref: string): string {
  if (!/^[a-z_][a-z0-9_]*(\."[a-z_][a-z0-9_]*")?$/i.test(ref))
    throw new Error(`Bad SQL reference: ${ref}`);
  return ref;
}

/**
 * Whether the user `column` (an int SQL expression) is named on any CsamReport (subject or secondary
 * user).
 */
export function heldUserSql(column: string): string {
  const user = sqlRef(column);
  return `(
      EXISTS (SELECT 1 FROM "CsamReport" hr WHERE hr."userId" = ${user})
      -- Compared as text, the form "CsamReport_secondaryUserId_idx" indexes, so Postgres picks an
      -- index probe per row for a few rows or one hashed read per statement for many.
      -- secondaryUserId is stored as a JSON number; a writer that stores text must normalize it.
      -- A hand-written "007" matches no one; the pattern keeps a negative id matching no one.
      OR EXISTS (
        SELECT 1 FROM "CsamReport" hs
        WHERE hs.details ->> 'secondaryUserId' = (${user})::text
          AND hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
      )
    )`;
}

/** Whether the "Image" row aliased `image` is itself in the CSAM queue or blocked as CSAM (anywhere in its comma list). */
export function heldItemImageSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  return `(${image}."needsReview" = 'csam' OR ${csamInBlockedForSql(`${image}."blockedFor"`)})`;
}

/**
 * Whether the "Image" row aliased `image` may be served: it is flagged for CSAM itself, or its owner
 * is held (`heldUserSql`). The one definition both routes run, as plain SQL so each app wraps it in
 * its own builder.
 *
 * The owner legs skip an AiNotVerified block, which the owner lifts by verifying, and never count the
 * placeholder owner, whose content a report naming it would otherwise open.
 */
export function heldImageSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  const owner = `${image}."userId"`;
  // Keep in step with the main app's OWNER_MEDIA_EXEMPT_BLOCKS (image-block-marker.ts): an image
  // blocked for a reason added there and not here is still held here whenever its owner is held.
  return `(
    ${image}."needsReview" = 'csam'
    OR ${csamInBlockedForSql(`${image}."blockedFor"`)}
    OR (${owner} <> ${PLACEHOLDER_OWNER_ID}
      AND ${image}."blockedFor" IS DISTINCT FROM 'AiNotVerified' AND ${heldUserSql(owner)})
  )`;
}

/**
 * Whether another image on the same stored url as the "Image" row aliased `image` is held by its
 * own state: a live row in the CSAM queue, blocked as CSAM (`heldItemImageSql`) or listed on any
 * CsamReport, or a moderator-deleted one that was in CSAM review or is listed. The same file must
 * not be served through a second row. Item-level only, never the owner's, which is why it is not
 * `heldUrlSql` (held-url.ts), whose legs also read the owner, post and model. Never NULL.
 */
export function sharedFileHeldImageSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image) || image === 'sf_i' || image === 'sf_d')
    throw new Error(`Bad table alias: ${image}`);
  return `(
    EXISTS (
      SELECT 1 FROM "Image" sf_i
      WHERE sf_i.url = ${image}.url AND sf_i.id <> ${image}.id
        AND (${heldItemImageSql(
          'sf_i'
        )} OR (sf_i.id)::text IN (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL}))
    )
    OR EXISTS (
      SELECT 1 FROM "ImageCdnModeratorDelete" sf_d
      WHERE sf_d.url = ${image}.url AND sf_d."imageId" <> ${image}.id
        AND (sf_d."csamReview" OR (sf_d."imageId")::text IN (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL}))
    )
  )`;
}

/** `heldImageSql`, false rather than NULL for an image with no review flag or block reason. */
export function heldImageKnownSql(image: string): string {
  return `COALESCE(${heldImageSql(image)}, false)`;
}

/**
 * Whether the "Image" row aliased `image` is marked as CSAM by a hash block, a scan flag, a
 * moderator vote or a CSAM hold on its label item. Not `heldImageSql`'s legs. With
 * `scanFlag: false` a scan flag alone does not count; with `hold: false` a hold alone does not.
 */
export function csamSignalImageSql(
  image: string,
  { scanFlag = true, hold = true }: { scanFlag?: boolean; hold?: boolean } = {}
): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  const id = `${image}.id`;
  const flagged = scanFlag
    ? `
        OR EXISTS (
          SELECT 1 FROM "ScanLabelFlag" sf WHERE sf."itemId" = si.id AND sf.snapshot ->> 'csam' = 'true'
        )`
    : '';
  return `(
    EXISTS (
      SELECT 1 FROM "BlockedImage" sb WHERE sb.hash = ${image}."pHash" AND sb.reason = 'CSAM'
    )
    OR EXISTS (
      SELECT 1 FROM "ScanLabelItem" si
      WHERE si."imageId" = ${id} AND (
        ${hold ? `si."voidReason" = 'csam-hold'` : 'false'}${flagged}
        OR EXISTS (
          SELECT 1 FROM "ScanLabelVote" sv WHERE sv."itemId" = si.id AND sv.reason = 'csam-realistic'
        )
      )
    )
  )`;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** A signed 64-bit integer as SQL literal text; throws on anything else, since the text is spliced. */
function int64Literal(value: bigint | string): string {
  const text = String(value);
  if (!/^-?\d{1,19}$/.test(text)) throw new Error('Bad int64');
  const n = BigInt(text);
  if (n < INT64_MIN || n > INT64_MAX) throw new Error('Bad int64');
  return n.toString();
}

/**
 * Copies blocklist CSAM entries into "BlockedImage", the table `csamSignalImageSql` reads; a row of
 * another reason becomes CSAM. Never deletes: no unblock ends a live CSAM entry, and a stale row only
 * keeps an image to moderators cleared for CSAM review. `null` for no hashes. Starts with
 * @civitai/db's REDACT_LOG_MARKER, so the slow-query log never records the hashes.
 */
export function mirrorBlockedHashesSql(hashes: (bigint | string)[]): string | null {
  const values = [...new Set(hashes.map(int64Literal))];
  if (!values.length) return null;
  return `/* log:redact */ INSERT INTO "BlockedImage" (hash, reason) VALUES ${values
    .map((hash) => `(${hash}, 'CSAM')`)
    .join(', ')} ON CONFLICT (hash) DO UPDATE SET reason = EXCLUDED.reason`;
}

/** Whether the scan of the "Image" row aliased `image` has not finished, so its signals cannot be
 *  read. A Blocked image finished its scan. */
export function unreadableImageSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  return `(${image}."ingestion"::text NOT IN ('Scanned', 'Blocked'))`;
}

/**
 * Each blocked_images hash's newest row as (reason, disabled): argMax on created_at, where on a
 * same-second tie a live CSAM row wins. The app's CSAM-entry readers use this same tie-break
 * (csamBlockedHashes in both apps), so everything that reads it agrees on every row.
 */
export const NEWEST_BLOCKLIST_ROW_SQL = `argMax(tuple(reason, disabled), tuple(created_at, reason = 'CSAM' AND disabled = false))`;

/** Hashes whose newest row is a live CSAM entry. */
export const LIVE_CSAM_SQL = `SELECT toString(hash) AS hash FROM (
  SELECT hash, ${NEWEST_BLOCKLIST_ROW_SQL} AS newest
  FROM blocked_images
  WHERE hash IN (SELECT hash FROM blocked_images WHERE reason = 'CSAM')
  GROUP BY hash
) WHERE tupleElement(newest, 1) = 'CSAM' AND tupleElement(newest, 2) = false`;

/** Each image id listed on a CsamReport, as text, with that report's createdAt (a row per listing). */
export const CSAM_REPORT_LISTINGS_SQL = `SELECT listed.id, listed."createdAt" FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id,
      lr."createdAt"
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL`;

/** A predicate on the CsamReport row aliased `alias`, as SQL text with no parameters. */
export type CsamReportFilter = (alias: string) => string;

/** Every image id listed on a CsamReport passing `filter` (on any report if none is given), as text. */
export const csamReportListedImageIdsSql = (filter?: CsamReportFilter) => `SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le${
      filter
        ? `
    WHERE ${filter('lr')}`
        : ''
    }
  ) listed
  WHERE listed.id IS NOT NULL`;

/** Every image id listed on any CsamReport, whatever its state, as text. */
export const CSAM_REPORT_LISTED_IMAGE_IDS_SQL = csamReportListedImageIdsSql();

/**
 * The users a CsamReport passing `filter` names, as its subject or its secondary user. One distinct
 * `"userId"` text per row, never null, since the secondary user is read out of the report's details.
 */
export const csamReportNamedUserIdsSql = (filter: CsamReportFilter) => `
  SELECT hc."userId"::text AS "userId"
  FROM "CsamReport" hc
  WHERE hc."userId" IS NOT NULL AND ${filter('hc')}
  UNION
  SELECT hs.details ->> 'secondaryUserId'
  FROM "CsamReport" hs
  WHERE hs.details ->> 'secondaryUserId' IS NOT NULL AND ${filter('hs')}
`;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
/** Containers every current browser plays. The codec inside is the browser's call: one it cannot
 *  decode fires the element's `error`, which the grid renders as the placeholder. */
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);

const OPAQUE = 'application/octet-stream';

const normalize = (type: string | null | undefined) =>
  (type ?? '').split(';')[0].trim().toLowerCase();

/**
 * The content type to serve, from the first candidate on the whitelist (the store's header, then the
 * row's `mimeType`). An image of any other type goes out opaque, never as svg or html. A video of any
 * other type returns `null`: it is refused rather than offered as a download.
 */
export function heldMediaContentType(
  mediaType: string,
  candidates: (string | null | undefined)[]
): string | null {
  const allowed = mediaType === 'video' ? VIDEO_TYPES : IMAGE_TYPES;
  const hit = candidates.map(normalize).find((type) => allowed.has(type));
  if (hit) return hit;
  return mediaType === 'video' ? null : OPAQUE;
}

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/** A `Range` header worth forwarding to the store: one range, at least one bound. Anything else is
 *  dropped and the whole object is served, which every client must accept. */
export function forwardableRange(header: string | null | undefined): string | null {
  const match = header?.trim().match(SINGLE_RANGE);
  if (!match || (!match[1] && !match[2])) return null;
  return `bytes=${match[1]}-${match[2]}`;
}

/** Whether a response gets its own audit row: every one that starts at byte 0, read from what the
 *  store sent rather than what was asked. A video's seeks are mid-file ranges of a view already
 *  recorded, and only those are skipped. */
export function isAuditedServe(upstream: {
  status: number;
  headers: { get(name: string): string | null };
}): boolean {
  if (upstream.status === 200) return true;
  return /^bytes 0-/.test(upstream.headers.get('content-range') ?? '');
}

/** The headers every held-media response carries. `withBody: false` for a response sent empty. */
export function heldMediaHeaders(
  contentType: string,
  upstream: { get(name: string): string | null },
  withBody = true
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-disposition': 'inline',
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
    'accept-ranges': 'bytes',
    'cross-origin-resource-policy': 'same-origin',
  };
  const range = upstream.get('content-range');
  if (range) headers['content-range'] = range;
  // fetch decodes a content-encoded body, so the stored length would no longer match it.
  const length = upstream.get('content-length');
  if (length && withBody && !upstream.get('content-encoding')) headers['content-length'] = length;
  return headers;
}

const INT_MAX = 2_147_483_647;

/** The grid's own report of how many items it showed, for its one summary row: a positive integer,
 *  clamped to what the row's int column holds rather than refused. */
export function heldGridCount(body: unknown): { count: number; clamped: boolean } | null {
  const count = (body as { count?: unknown } | null)?.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) return null;
  return { count: Math.min(count, INT_MAX), clamped: count > INT_MAX };
}

/** The header a refusal carries when the image is not held, as opposed to any other failure. Only
 *  this answer may send a caller to the public CDN instead. */
export const NOT_HELD_HEADER = 'x-held-media';
export const NOT_HELD = 'not-held';

/** Whether a route answer is that explicit not-held refusal, the only case for the CDN. */
export const isNotHeldAnswer = (res: {
  status: number;
  headers: { get(name: string): string | null };
}) => res.status === 404 && res.headers.get(NOT_HELD_HEADER) === NOT_HELD;

const STORE_HEADERS_TIMEOUT_MS = 30_000;

/** The stored object, forwarding `range`. The store has 30 s to answer; the body then streams for as
 *  long as `signal` (the client) lasts, so a long video is never cut off by the timer. */
export async function fetchHeldObject(
  url: string,
  range: string | null,
  signal: AbortSignal
): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), STORE_HEADERS_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: range ? { range } : {},
      signal: AbortSignal.any([signal, timeout.signal]),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** The log line for one response that carries held bytes, written before the first byte leaves.
 *  `bytes` is the length the store declared for this response, `null` when it sent none. */
export function heldServeRecord(input: {
  moderatorId: number;
  imageId: number;
  status: number;
  range: string | null;
  upstream: { get(name: string): string | null };
}) {
  const header = input.upstream.get('content-length');
  const length = header ? Number(header) : NaN;
  return {
    name: 'held-media-serve',
    type: 'info',
    moderatorId: input.moderatorId,
    imageId: input.imageId,
    status: input.status,
    range: input.range,
    bytes: Number.isFinite(length) ? length : null,
  };
}

/** What a moderator did with one image on screen: opened its full view, or selected it. */
export type ShownAction = 'open' | 'select';
/** Which copy was on screen: the stored original, or the public CDN's 450px rendition. */
export type ShownRendition = 'original' | 'cdn-450';
export const SHOWN_ACTIONS: readonly ShownAction[] = ['open', 'select'];
export const SHOWN_RENDITIONS: readonly ShownRendition[] = ['original', 'cdn-450'];

/** The ModActivity `activity` for one shown image. ModActivity has no details column, so the act and
 *  the rendition ride in the string. */
export const shownActivity = (action: ShownAction, rendition: ShownRendition) =>
  `reportMedia:${action}:${rendition}` as const;

/** The ModActivity `activity` for held bytes served to a moderator from byte 0. */
export const SERVED_ACTIVITY = 'heldMedia:view';

/** The share of a video actually played: the union of its `played` ranges over its duration. A seek
 *  adds nothing, since `played` holds only what played. 0 while the duration is unknown. */
export function playedFraction(video: {
  duration: number;
  played: { length: number; start(i: number): number; end(i: number): number };
}): number {
  const { duration, played } = video;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const ranges = Array.from({ length: played.length }, (_, i) => [played.start(i), played.end(i)])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let reached = -Infinity;
  for (const [start, end] of ranges) {
    const from = Math.max(start, reached);
    if (end > from) total += end - from;
    reached = Math.max(reached, end);
  }
  return Math.min(total / duration, 1);
}

/** The share of a video that must have played before it counts as watched. */
export const WATCHED_FRACTION = 0.95;

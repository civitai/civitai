import { childBrowsingTagIds } from './browsing-addon-tags';
import { NsfwLevel } from './browsing-levels';

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
 * user) or has an active evidence hold. Names the "EvidenceHeldUser" view, so a database without it
 * fails the statement, which refuses.
 */
export function heldUserSql(column: string): string {
  const user = sqlRef(column);
  return `(
      EXISTS (SELECT 1 FROM "CsamReport" hr WHERE hr."userId" = ${user})
      -- Uncorrelated, so Postgres reads the reports once per statement rather than once per row.
      -- CASE as well as the filter: Postgres may cast before it tests the pattern, and one bad
      -- row would fail every request. The filter keeps NULLs out, so IN is never unknown.
      OR COALESCE(${user} IN (
        SELECT CASE WHEN hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
                    THEN (hs.details ->> 'secondaryUserId')::bigint END
        FROM "CsamReport" hs
        WHERE hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
      ), false)
      OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" he WHERE he."userId" = ${user})
    )`;
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
  return `(
    ${image}."needsReview" = 'csam'
    OR ${image}."blockedFor" = 'CSAM'
    OR (${owner} <> ${PLACEHOLDER_OWNER_ID}
      AND ${image}."blockedFor" IS DISTINCT FROM 'AiNotVerified' AND ${heldUserSql(owner)})
  )`;
}

const SUSPECT_VOTE_REASONS = ['csam-realistic', 'school-nsfw'];

/**
 * Whether the "Image" row aliased `image` carries a CSAM or minor signal: everything `heldImageSql`
 * holds, plus the minor flags and the minor review queue, a child-type tag on an image rated R or above (the same tags and
 * levels the default browsing add-on hides from mature browsing), a CSAM hash block, a scan flag
 * reporting CSAM or a minor, a moderator vote naming one, or a CSAM hold on its label item.
 *
 * `Image.blockedFor` beyond 'CSAM' and the scanner's ClickHouse labels are not here: the first is
 * matched against private patterns (`blockedForSignal`), the second lives in another store.
 */
export function suspectImageSql(image: string): string {
  const held = heldImageSql(image);
  const id = `${image}.id`;
  return `(
    ${held}
    OR ${image}."minor" = TRUE OR ${image}."acceptableMinor" = TRUE OR ${image}."needsReview" = 'minor'
    OR ((${image}."nsfwLevel" = 0 OR ${image}."nsfwLevel" >= ${NsfwLevel.R}) AND EXISTS (
      SELECT 1 FROM "TagsOnImageDetails" st
      WHERE st."imageId" = ${id} AND st."tagId" IN (${childBrowsingTagIds.join(', ')})
        AND st."disabled" = FALSE
    ))
    OR EXISTS (
      SELECT 1 FROM "BlockedImage" sb WHERE sb.hash = ${image}."pHash" AND sb.reason = 'CSAM'
    )
    OR EXISTS (
      SELECT 1 FROM "ScanLabelItem" si
      WHERE si."imageId" = ${id} AND (
        si."voidReason" = 'csam-hold'
        OR EXISTS (
          SELECT 1 FROM "ScanLabelFlag" sf
          WHERE sf."itemId" = si.id
            AND (sf.snapshot ->> 'csam' = 'true' OR sf.snapshot ->> 'minorDetected' = 'true')
        )
        OR EXISTS (
          SELECT 1 FROM "ScanLabelVote" sv
          WHERE sv."itemId" = si.id
            AND (sv.reason IN (${SUSPECT_VOTE_REASONS.map((r) => `'${r}'`).join(', ')})
              OR sv.reason LIKE 'minor-%')
        )
      )
    )
  )`;
}

/** Whether the scan of the "Image" row aliased `image` has not finished, so its signals cannot be
 *  read. A Blocked image finished its scan. */
export function unreadableImageSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  return `(${image}."ingestion"::text NOT IN ('Scanned', 'Blocked'))`;
}

/** Every image id listed on any CsamReport, whatever its state, as text. */
export const CSAM_REPORT_LISTED_IMAGE_IDS_SQL = `SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL`;

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

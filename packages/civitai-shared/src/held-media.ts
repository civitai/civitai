/**
 * Serving review-queue media to moderators from storage rather than the public image CDN. Shared by
 * the moderator app's `/api/held-media` and the main app's `/api/mod/held-media`, so the two routes
 * cannot disagree on what a browser is allowed to render from their origin.
 */

/** The owner `deleteUser` hands kept content to; the main app's `PLACEHOLDER_OWNER_ID`. */
const PLACEHOLDER_OWNER_ID = -1;

/**
 * Whether the "Image" row aliased `image` may be served: it is flagged for CSAM itself, or its owner
 * is named on any CsamReport (subject or secondary user) or has an active evidence hold. The one
 * definition both routes run, as plain SQL so each app wraps it in its own builder.
 *
 * The owner legs skip an AiNotVerified block, which the owner lifts by verifying, and never count the
 * placeholder owner, whose content a report naming it would otherwise open. Names the
 * "EvidenceHeldUser" view, so a database without it fails the statement, which refuses.
 */
export function heldImageSql(image: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(image)) throw new Error(`Bad table alias: ${image}`);
  const owner = `${image}."userId"`;
  return `(
    ${image}."needsReview" = 'csam'
    OR ${image}."blockedFor" = 'CSAM'
    OR (${owner} <> ${PLACEHOLDER_OWNER_ID}
      AND ${image}."blockedFor" IS DISTINCT FROM 'AiNotVerified' AND (
      EXISTS (SELECT 1 FROM "CsamReport" hr WHERE hr."userId" = ${owner})
      OR EXISTS (
        SELECT 1 FROM "CsamReport" hs
        -- CASE, not AND: Postgres may cast before it tests the pattern, and one bad row would fail
        -- every request.
        WHERE CASE WHEN hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
                   THEN (hs.details ->> 'secondaryUserId')::bigint END = ${owner}
      )
      OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" he WHERE he."userId" = ${owner})
    ))
  )`;
}

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

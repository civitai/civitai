/**
 * Serving review-queue media to moderators from storage rather than the public image CDN. Shared by
 * the moderator app's `/api/held-media` and the main app's `/api/mod/held-media`, so the two routes
 * cannot disagree on what a browser is allowed to render from their origin.
 */

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

/**
 * Whether this request opens a full view, so it is audited. A video player follows its first request
 * with a range per seek; only the one from byte 0 (or with no range) counts, so one view is one row.
 */
export function isFullViewOpen(view: string | null | undefined, range: string | null): boolean {
  if (view !== 'full') return false;
  // `bytes=0-1` is Safari's probe ahead of its real first request.
  return range == null || (range.startsWith('bytes=0-') && range !== 'bytes=0-1');
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
  };
  const range = upstream.get('content-range');
  if (range) headers['content-range'] = range;
  // fetch decodes a content-encoded body, so the stored length would no longer match it.
  const length = upstream.get('content-length');
  if (length && withBody && !upstream.get('content-encoding')) headers['content-length'] = length;
  return headers;
}

const HELD_GRID_MAX = 1000;

/** The grid's own report of how many held items it showed: one audit row per page, no image ids. */
export function heldGridCount(body: unknown): number | null {
  const count = (body as { count?: unknown } | null)?.count;
  return Number.isInteger(count) && (count as number) > 0 && (count as number) <= HELD_GRID_MAX
    ? (count as number)
    : null;
}

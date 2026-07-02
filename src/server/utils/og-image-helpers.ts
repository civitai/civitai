import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { MediaType } from '~/shared/utils/prisma/enums';

/**
 * Helpers for the OG-image endpoint (`src/pages/api/og.tsx`).
 *
 * The card embeds the entity's cover image via `<img src={remoteUrl}>`, which
 * @vercel/og's `ImageResponse` (satori) fetches INTERNALLY with NO timeout. On a
 * slow CF edge (or an on-demand video→image transcode) that unbounded fetch
 * stalls the whole render — live spanmetrics showed p50 839ms / p95 4.6s /
 * p99 19.4s on an already-edge-cached endpoint (so this is purely cold first-
 * render cost, and the bimodal tail is the signature of the unbounded fetch).
 *
 * `fetchImageAsDataUri` takes control of that fetch: it pulls the bytes itself
 * with a bounded `AbortSignal.timeout`, and returns a `data:` URI the caller
 * passes to satori instead of the remote URL — so satori embeds bytes and never
 * does its own (untimed) fetch. On ANY failure (timeout, non-2xx, oversize,
 * network error) it returns `null`, and the caller falls back to the no-image /
 * placeholder path. A slow or failed cover image must never block or fail the
 * render — that's what caps the p99.
 */

/**
 * Default per-image fetch budget. Chosen at 2500ms: well under the observed
 * p99 (19.4s) so it caps the tail, while still comfortably above p50/p95
 * (839ms / 4.6s) so the common case still embeds the real cover. The card is
 * edge-cached for 7 days, so paying up to ~2.5s on a cold render is acceptable;
 * exceeding it just falls back to the logo placeholder rather than hanging.
 */
export const OG_IMAGE_FETCH_TIMEOUT_MS = 2500;

/**
 * Upper bound on the cover-image body we'll buffer into a data URI. A 1200×630
 * card image at quality 90 is tens-to-hundreds of KB; 6MB is generous headroom
 * while still guarding against a pathological response blowing memory. Enforced
 * both via the `Content-Length` header (cheap, pre-buffer) and the actual byte
 * length (in case the header lies / is absent).
 */
export const OG_IMAGE_MAX_BYTES = 6 * 1024 * 1024;

/**
 * Build the edge URL for an entity's cover image as embedded in the OG card.
 *
 * For an IMAGE cover this is a plain `fit:cover` resize. For a VIDEO cover we
 * request a STILL FRAME — `type:image` (→ `.jpeg` extension) + `anim:false` +
 * `transcode:true` — the exact edge-URL the site's own video poster uses
 * (`EdgeVideoBase`'s `<video poster>`). That returns a JPEG, NOT an mp4, so it
 * embeds in the OG PNG like any image cover. The still frame can be slow on a
 * cold cacher miss, but the caller pipes this through `fetchImageAsDataUri`'s
 * bounded timeout and falls back to the logo placeholder — so a video model
 * gets a real preview when the frame is warm, and never stalls the render.
 */
export function buildOgCoverEdgeUrl(
  image: { url: string; type: MediaType },
  dims: { width: number; height: number }
): string {
  const isVideo = image.type === MediaType.video;
  return getEdgeUrl(image.url, {
    width: dims.width,
    height: dims.height,
    fit: 'cover',
    quality: 90,
    ...(isVideo ? { type: MediaType.image, anim: false, transcode: true } : {}),
  });
}

export type FetchImageAsDataUriOptions = {
  timeoutMs?: number;
  maxBytes?: number;
};

/**
 * Fetch a remote image with a bounded timeout and return it as a base64 `data:`
 * URI, or `null` on any failure (timeout/abort, non-2xx, oversize, or fetch
 * error). Never throws — callers treat `null` as "render without the cover".
 */
export async function fetchImageAsDataUri(
  url: string,
  { timeoutMs = OG_IMAGE_FETCH_TIMEOUT_MS, maxBytes = OG_IMAGE_MAX_BYTES }: FetchImageAsDataUriOptions = {}
): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;

    // Pre-buffer guard: if the server advertises an oversize body, bail before
    // reading it into memory.
    const contentLength = res.headers.get('content-length');
    if (contentLength) {
      const declared = Number(contentLength);
      if (Number.isFinite(declared) && declared > maxBytes) return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    // Empty-body guard: a 200 with a 0-byte body would otherwise produce an
    // empty `data:image/...;base64,` payload that satori throws on — degrading
    // to the generic FallbackCard. Return null so the caller routes to the
    // nicer entity-card-with-placeholder path instead.
    if (arrayBuffer.byteLength === 0) return null;
    // Post-buffer guard: header may be absent or lie (e.g. chunked).
    if (arrayBuffer.byteLength > maxBytes) return null;

    const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return `data:${contentType};base64,${base64}`;
  } catch {
    // Timeout/abort, network error, malformed response — fall back to no image.
    return null;
  }
}

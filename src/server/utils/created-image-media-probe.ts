import type { S3Client } from '@aws-sdk/client-s3';
import { getImageUploadBackend, headObject } from '~/utils/s3-utils';

/**
 * Does the media an `Image` row is about to point at actually exist in the store?
 *
 * `createImage` writes its row from client-supplied JSON. `url` — the media key — arrives
 * over the wire and is never checked against storage, so a key whose object never landed
 * produces a complete, healthy-looking row whose media 404s forever. There is no repair
 * path: nothing later in the pipeline re-derives the bytes.
 *
 * The dominant producer is the browser upload hook (`src/hooks/useCFImageUpload.tsx`).
 * XHR's `error` event is NETWORK-ONLY, so a PUT that reaches the store and is REFUSED
 * (an expired presign, a malformed request, a briefly unavailable store) completes
 * normally, lands on `loadend`, and the hook proceeds to hand the caller a key with
 * nothing behind it. Measured over a ~24h production window, 7 of 10 sampled defective
 * rows had a key an upload endpoint had signed 2.0–23.3s before the row was written, with
 * zero bytes ever stored — a real upload attempt that failed silently down that path.
 *
 * 🔴 WHAT THIS COVERS, STATED EXACTLY: `Image` rows written through `createImage`. That is
 * the widest single funnel — post images, model-version and collection paths, comics, cover
 * images, thumbnails — and it reaches every session regardless of which bundle it loaded,
 * which a client-side fix cannot. It is NOT every `Image` row: five write paths reach the
 * table directly and are enumerated at the call site in `~/server/services/image.service`
 * (`createImage`), the highest-risk being `linkArticleContentImages`, which materialises
 * TipTap article content — fed by the same resolves-on-a-refused-PUT hook described above —
 * inside a `dbWrite.$transaction`, where `local-rules/no-io-in-transaction` is what makes
 * adding a HEAD a separate change rather than an extra argument.
 *
 * An earlier version of this comment claimed the funnel was total ("every `Image` row … so
 * a check here covers every producer … including the ones nobody has enumerated"). It is
 * not, and nothing here establishes whether this half or the client half leaves more rows
 * uncovered — both are partial in different directions.
 *
 * 🔴 OBSERVE-ONLY. This module answers a question; it does not act on the answer. The
 * caller logs the verdict and continues. Rejecting an image creation is a NEW failure mode
 * on a working user-facing path, and the only honest way to size it is to let the `absent`
 * rate accumulate against a real denominator first. Enforcement is deliberately a separate
 * change, gated on that measurement.
 */

/**
 * The one rule for "may this `Image.url` be handed to our media store as an object key?".
 *
 * 🔴 A DELIBERATE UNDER-APPROXIMATION, and the direction is chosen from what each error
 * costs. It is NOT true that every legitimate key here is a uuid: every key-MINTING site is
 * a bare `crypto.randomUUID()` with no prefix and no extension, but several WRITE paths
 * accept a caller-supplied string and never check its shape, so `foo/uuid`, `photo.jpg` or
 * `12345` can all reach this column. Probing those would produce 404s that are
 * indistinguishable from real misses and would inflate the `absent` rate this check exists
 * to measure — so they are classified `not-applicable` and never asked about. A key we
 * decline to probe costs a detection; a non-key we probe costs a wrong measurement.
 *
 * A url carrying a URI scheme (`http:`, `blob:`, `data:`) fails this for free — none of
 * them is a uuid.
 *
 * 🔴 KNOWN DUPLICATE, RECORDED RATHER THAN HIDDEN. An identical predicate is being added as
 * `@civitai/shared`'s `isProbeableMediaKey` by the publish-guard change (civitai#4490),
 * which is open and unmerged. This repo forbids stacked PRs, so importing it here would
 * base this change on that branch. The two must be consolidated onto the shared module by
 * whichever lands second — a predicate open-coded at N sites is wrong at N-1 of them, and
 * these two are the same question asked by two guards. That is a real follow-up, and its
 * closing condition is mechanical: this file no longer declares `MEDIA_KEY_RE`.
 */
const MEDIA_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProbeableMediaKey(url: unknown): url is string {
  return typeof url === 'string' && MEDIA_KEY_RE.test(url);
}

/**
 * What the probe concluded. 🔴 FOUR values, never a boolean.
 *
 * A boolean forces the fail-open case to be reported as one of the other two, and both
 * readings are wrong: counting `unknown` as present asserts we confirmed an object we never
 * saw, and counting it as absent inflates the defect rate with probes that could not reach
 * the bucket at all. Both directions corrupt the measurement this exists to take.
 *
 * Mirrors the three-valued shape `headObject` already returns in `~/utils/s3-utils`.
 */
export type CreatedImageMediaVerdict =
  /** The store answered that the key is there, with bytes. */
  | 'present'
  /** The store ANSWERED absent, or answered present with zero bytes. This is the defect. */
  | 'absent'
  /** The store could not be consulted — threw, timed out, or is unconfigured. Fail open. */
  | 'unknown'
  /** `url` is not a bare media key this store owns, so there is nothing to ask about. */
  | 'not-applicable';

/**
 * Timeout budget for the probe.
 *
 * 🔴 A BOUND IS NOT OPTIONAL. `createImage` sits inline on a user-facing mutation and the
 * uploads client is built with SDK-default retries and no request timeout, so an unbounded
 * probe against a degraded store does not fail open — it HANGS the request holding it,
 * which is strictly worse than the bug it observes.
 *
 * 2s, taken from `COVER_IMAGE_EXISTS_TIMEOUT_MS` in `~/server/services/cover-image.service`
 * rather than picked afresh, so the two probes against this same store cannot drift apart.
 * An abort surfaces as an `AbortError`, which is not a not-found shape, so it lands on
 * `unknown` like any other unreachable-bucket outcome.
 *
 * 🔴 THIS BOUNDS EACH NETWORK ATTEMPT, NOT WALL-CLOCK TIME. `~/utils/s3-utils` records the
 * mechanism on `checkFileExists` and `headObject`: the signal is shared by every retry
 * attempt, but the SDK sleeps BETWEEN attempts on a plain, non-abort-aware timer, so a
 * deadline landing mid-backoff lets that sleep run to completion and only the next attempt
 * short-circuits. Worst case per call is therefore this budget plus one backoff, not 2s.
 * `getB2ImageS3Client` (`~/utils/s3-utils`) sets neither `maxAttempts` nor a
 * request-handler timeout, so the backoff length is whatever the SDK default schedule
 * produces — s3-utils records one measurement against the installed SDK, a 300ms budget
 * with a ~5s backoff in flight returning in ~4.7s. The consequence for the callers that
 * loop is sized at the `createImage` call site.
 */
export const CREATED_IMAGE_MEDIA_PROBE_TIMEOUT_MS = 2000;

/**
 * Seam for tests. Both default to the real implementations, so production behaviour is
 * whatever `getImageUploadBackend` / `headObject` do — the injection point exists so a test
 * can drive every verdict without a bucket, not so the probe can differ in production.
 */
export type CreatedImageMediaProbeDeps = {
  getBackend: () => Promise<{ s3: S3Client; bucket: string }>;
  headObject: typeof headObject;
};

/**
 * 🔴 THE BUCKET IS RESOLVED THROUGH `getImageUploadBackend()`, NOT OPEN-CODED.
 *
 * `Image.url` is the key the UPLOAD path minted, so the only store that can answer about it
 * is the one that path writes to. Every key-minting site already goes through this resolver,
 * so the probe asks about the bucket the key was actually minted into by construction rather
 * than by two constants happening to agree today. `cover-image.service` resolves the same
 * way; an open-coded client plus a bucket literal would silently keep asking the old store
 * the moment uploads move, and answer 404 for every key.
 */
const defaultDeps: CreatedImageMediaProbeDeps = {
  getBackend: async () => {
    const { s3, bucket } = await getImageUploadBackend();
    return { s3, bucket };
  },
  headObject,
};

/**
 * 🔴 NEVER THROWS. This observes a working code path, so it must not be able to break that
 * path by its own absence: resolving the backend is inside the try, and an unconfigured
 * environment (local, CI, rotated credentials) lands on `unknown` rather than propagating.
 */
export async function probeCreatedImageMedia(
  url: unknown,
  deps: CreatedImageMediaProbeDeps = defaultDeps
): Promise<CreatedImageMediaVerdict> {
  if (!isProbeableMediaKey(url)) return 'not-applicable';

  try {
    const { s3, bucket } = await deps.getBackend();
    const head = await deps.headObject(bucket, url, s3, {
      abortSignal: AbortSignal.timeout(CREATED_IMAGE_MEDIA_PROBE_TIMEOUT_MS),
    });
    if (head.status === 'absent') return 'absent';
    if (head.status === 'unknown') return 'unknown';
    /**
     * A zero-length object is a stored object that cannot render — the same defect from the
     * viewer's point of view, and the shape the production sample actually showed. `size:
     * null` is "the backend reported no length", NOT "size zero", so it must not trip this;
     * see `ObjectHeadResult`.
     */
    if (head.size === 0) return 'absent';
    return 'present';
  } catch {
    return 'unknown';
  }
}

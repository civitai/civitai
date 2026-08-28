import type { S3Client } from '@aws-sdk/client-s3';
import { getImageUploadBackend, headObject } from '~/utils/s3-utils';

/**
 * Does the media an `Image` row is about to point at actually exist in the store?
 *
 * `createImage` writes its row from client-supplied JSON. `url` (the media key),
 * `width`, `height`, `name`, `mimeType` and `sizeKB` all arrive over the wire and
 * none of them is checked against storage, so any key a caller invents produces a
 * complete, healthy-looking row whose media 404s forever.
 *
 * Measured in production over ~22,800 image creations, 10 rows referenced media
 * that was never stored, in two distinct populations:
 *   - 7 had a key that WAS issued by an upload endpoint 2.0–23.3s before the row
 *     was written, but no object ever landed — a real upload that failed silently;
 *   - 3 had a key no endpoint ever issued at all.
 *
 * 🔴 That split is why this is an EXISTENCE check and not a "was this key ever
 * signed" registry lookup. A signature check sees only the second population — 3
 * of the 10. Asking the bucket sees all 10, and it is also the only question whose
 * answer stays true: a key can be signed and still have nothing behind it.
 */

/**
 * What the probe concluded. 🔴 THREE values, never a boolean.
 *
 * A boolean forces the fail-open case to be reported as one of the other two, and
 * both readings are wrong: counting `unknown` as present asserts we confirmed an
 * object we never saw, and counting it as absent inflates the defect rate with
 * probes that simply could not reach the bucket. Both directions corrupt the very
 * measurement the observe-only rollout exists to take.
 *
 * Mirrors the verdict shape already used by the multipart-completion path in
 * `src/pages/api/upload/complete.ts`.
 */
export type CreatedImageMediaVerdict =
  /** The bucket answered that the key is there. */
  | 'present'
  /** The bucket ANSWERED absent. This is the defect. */
  | 'absent'
  /** The bucket could not be consulted — probe threw, timed out, or is unconfigured. Fail open. */
  | 'unknown'
  /** `url` is not a bare media key this store owns, so there is nothing to ask about. */
  | 'not-applicable';

/**
 * Timeout budget for the probe. `createImage` sits on a user-facing mutation, and the
 * client is built with SDK-default retries and NO request timeout, so an unbounded
 * probe against a degraded backend would turn a guard into a hang — strictly worse
 * than the bug it guards.
 *
 * Per `headObject`'s contract this bounds each network ATTEMPT, not wall-clock: the
 * SDK's retry sleep is not abort-aware, so worst case is this budget plus one
 * backoff. An abort surfaces as an `AbortError`, which is not a not-found shape, so
 * it lands on `unknown` and the caller fails open like any other unreachable bucket.
 */
export const CREATED_IMAGE_MEDIA_PROBE_TIMEOUT_MS = 3_000;

/**
 * A bare media key — the UUID an upload endpoint issues and stores as `Image.url`.
 *
 * 🔴 Not every `Image.url` is one. `addPostImageSchema` accepts
 * `z.url().or(z.string().uuid())`, and legacy avatar rows hold a full external URL
 * where every other row holds a bucket key — the same distinction
 * `deleteImageFromS3` documents when it declines to delete an `http`-prefixed url
 * because it names a bucket we do not own. HEADing one of those against OUR bucket
 * asks a nonsensical question and would answer `absent` for a perfectly good row,
 * so those are classified `not-applicable` and never probed.
 *
 * Deliberately a positive test (it IS a uuid) rather than a negative one (it is NOT
 * an http url): a relative path, an empty string or a stray token is equally not a
 * key we can look up, and a negative test would send all of them to the bucket.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProbeableMediaKey(url: unknown): url is string {
  return typeof url === 'string' && UUID_RE.test(url);
}

/**
 * Seam for tests. Both default to the real implementations, so production behaviour
 * is whatever `getImageUploadBackend` / `headObject` do — the injection point exists
 * so a test can drive the three verdicts without a bucket, not so the probe can
 * behave differently in production.
 */
export type CreatedImageMediaProbeDeps = {
  getBackend: () => Promise<{ s3: S3Client; bucket: string }>;
  headObject: typeof headObject;
};

const defaultDeps: CreatedImageMediaProbeDeps = {
  getBackend: async () => {
    const { s3, bucket } = await getImageUploadBackend();
    return { s3, bucket };
  },
  headObject,
};

/**
 * 🔴 NEVER THROWS. This probe guards a working code path, so it must not be able to
 * fail that path by its own absence: resolving the backend is inside the try, and an
 * unconfigured environment lands on `unknown` rather than propagating.
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
     * A zero-length object is a stored object that cannot render, and is the same
     * defect from the reader's point of view. `size: null` is "the backend reported
     * no length", NOT "size zero", so it must not trip this — see `ObjectHeadResult`.
     */
    if (head.size === 0) return 'absent';
    return 'present';
  } catch {
    return 'unknown';
  }
}

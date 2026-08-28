import type { S3Client } from '@aws-sdk/client-s3';
import { isProbeableMediaKey } from '@civitai/shared/media-key';
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
  /**
   * 🔴 The SHARED predicate (`@civitai/shared/media-key`), not a local copy.
   *
   * This rule used to be open-coded here AND in the moderator publish guard, by
   * OPPOSITE construction — this one asked "is it a bare uuid?", that one asked
   * "does it carry a URI scheme?" and probed everything else. For `some-file.png`
   * they returned opposite verdicts, and on that side the verdict is a PERMANENT
   * refusal to publish. Read that module for why the surviving test is a
   * deliberate under-approximation rather than an accurate one.
   *
   * The two call sites act differently on the answer and that is fine: this one is
   * observe-only behind a flag defaulting off, so a wrong verdict is logged; the
   * publish guard's is enforced immediately. What must not differ is the QUESTION.
   */
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

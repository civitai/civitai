import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

import { logToAxiom } from '~/server/logging/client';
import { getImageUploadBackend } from '~/utils/s3-utils';

/**
 * Measure an image that has ALREADY been uploaded to the image store, by reading
 * the object back and decoding its header.
 *
 * The browser-direct / CLI upload flow is: mint a presigned PUT (`/api/v1/image-upload`),
 * PUT the raw bytes, then tell the server what was uploaded. Everything in that
 * last step — width, height, MIME, byte size — is a CLIENT CLAIM about bytes the
 * server never looked at, so any server-side rule expressed over those fields is
 * only as strong as client honesty. This reads the bytes the client actually
 * stored and reports what they are.
 *
 * 🔴 A POINT-IN-TIME reading, not a durable property of the key. The presigned PUT
 * remains usable for its whole expiry window, so the object can be replaced after
 * this returns. Callers may record "these values were measured from real bytes",
 * never "these values describe the object".
 *
 * {@link StoredImageProbe.etag} is what lets a later consumer tell those two apart:
 * recorded alongside the measurement, it turns "true at probe time" into a claim
 * that can be RE-CHECKED at the point of use via {@link headStoredImage}, without
 * re-reading (or re-decoding) the bytes.
 */

export type StoredImageProbeReason =
  /** No object at that key (nothing was uploaded, or the upload failed). */
  | 'missing'
  /** The stored object is bigger than the caller's budget. */
  | 'too-large'
  /** Present, but not a decodable image (or zero-length). */
  | 'unreadable'
  /** The store itself could not be consulted — infrastructure, not the caller. */
  | 'store-unavailable';

export class StoredImageProbeError extends Error {
  readonly reason: StoredImageProbeReason;

  constructor(reason: StoredImageProbeReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoredImageProbeError';
    this.reason = reason;
  }
}

export type StoredImageProbe = {
  /** Width as a viewer sees it — EXIF orientation applied. */
  width: number;
  /** Height as a viewer sees it — EXIF orientation applied. */
  height: number;
  /** Decoded container format, e.g. `png` / `jpeg` / `webp` / `gif`. */
  format: string;
  /** The object's true byte length in the store. */
  sizeBytes: number;
  /**
   * The store's entity tag for the object these values were read from, or `null`
   * when the backend did not return one. An OPAQUE token — never parsed, only
   * compared for equality against a later {@link headStoredImage} of the same key.
   * `null` is "the store said nothing", NOT "no object": it can never be treated
   * as evidence of anything.
   */
  etag: string | null;
};

/**
 * Outcome of re-reading the entity tag of an already-measured key.
 *
 * 🔴 THREE states, mirroring `headObject` in `~/utils/s3-utils`. `absent` = the
 * bucket ANSWERED that the key is gone; `unknown` = the bucket could not be
 * consulted at all, or answered without an `ETag`. Only `present` carries a token
 * that may be compared; the other two mean "we do not know", and a caller must
 * not read them as either agreement or disagreement.
 */
export type StoredImageHead =
  | { status: 'present'; etag: string | null }
  | { status: 'absent' }
  | { status: 'unknown' };

/**
 * Timeout budget for the entity-tag re-read.
 *
 * 🔴 A BOUND IS NOT OPTIONAL HERE. `headStoredImage` sits inline on a user-facing
 * mutation, and "the store errors" and "the store never answers" are different
 * failures: the fail-open posture below only covers the first. An unbounded head
 * against a degraded backend does not fail open, it HANGS the request holding it —
 * strictly worse than the tampering this check exists to catch.
 *
 * Same budget, and the same reasoning, as the post-completion probe in
 * `~/pages/api/upload/complete.ts`; taken from there rather than picked afresh so
 * the two probes against this store cannot drift apart. Per the AWS SDK's contract
 * this bounds each network ATTEMPT, not wall-clock — the retry sleep is not
 * abort-aware, so the worst case is this budget plus one backoff. An abort lands on
 * `unknown`, i.e. the check could not run.
 */
export const STORED_IMAGE_HEAD_TIMEOUT_MS = 5_000;

/**
 * Cheap HeadObject re-read of the entity tag at `key`, for a consumer that holds a
 * tag recorded by {@link probeStoredImage} and needs to know whether the object is
 * STILL the one that was measured. No bytes are transferred and nothing is decoded.
 *
 * 🔴 Never throws, and never converts a failure into a verdict: an unreachable or
 * unconfigured store lands on `unknown`, which is the caller's cue that the check
 * could not run — not that it failed. A timeout is one of those failures, not a
 * separate outcome: an aborted head is indistinguishable from an unreachable one
 * as far as what we know about the object.
 *
 * `timeoutMs` exists so the abort path is testable in milliseconds rather than
 * seconds. Production callers pass nothing.
 */
export async function headStoredImage(
  key: string,
  { timeoutMs = STORED_IMAGE_HEAD_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<StoredImageHead> {
  try {
    const { s3, bucket } = await getImageUploadBackend();
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    return { status: 'present', etag: typeof head?.ETag === 'string' ? head.ETag : null };
  } catch (err) {
    return isNotFoundError(err) ? { status: 'absent' } : { status: 'unknown' };
  }
}

function isNotFoundError(e: unknown) {
  const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    err?.name === 'NoSuchKey' ||
    err?.name === 'NotFound' ||
    err?.Code === 'NoSuchKey' ||
    err?.$metadata?.httpStatusCode === 404
  );
}

/** A zero-length object answers a `bytes=0-N` read with 416, not with 0 bytes. */
function isRangeNotSatisfiableError(e: unknown) {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err?.name === 'InvalidRange' || err?.$metadata?.httpStatusCode === 416;
}

/** `bytes 0-16383/16384` → 16384. Falls back to what we actually read. */
function parseTotalSize(contentRange: string | undefined, readBytes: number): number {
  const total = contentRange?.split('/')[1];
  const parsed = total != null ? Number(total) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : readBytes;
}

/**
 * Read back the object at `key` in the image-upload store and decode its header.
 *
 * The read is a single ranged GET of `maxBytes + 1`, so an oversize object costs
 * one bounded request rather than a full download: the `Content-Range` total is
 * the object's real size, and anything at or under the budget arrives whole.
 * Throws {@link StoredImageProbeError} — callers map `reason` to their own
 * client-facing error (`store-unavailable` is the only one that is not the
 * caller's fault).
 */
export async function probeStoredImage(
  key: string,
  { maxBytes }: { maxBytes: number }
): Promise<StoredImageProbe> {
  let bytes: Buffer;
  let sizeBytes: number;
  let etag: string | null;
  try {
    const { s3, bucket } = await getImageUploadBackend();
    const object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${maxBytes}` })
    );
    if (!object.Body) throw new StoredImageProbeError('unreadable', 'stored image has no body');
    bytes = Buffer.from(await object.Body.transformToByteArray());
    sizeBytes = parseTotalSize(object.ContentRange, bytes.byteLength);
    // A ranged GET still reports the WHOLE object's entity tag, so this costs no
    // extra request: it identifies the very bytes the measurement below is taken
    // from, which is exactly what a later re-check needs.
    etag = typeof object.ETag === 'string' ? object.ETag : null;
  } catch (err) {
    if (err instanceof StoredImageProbeError) throw err;
    if (isNotFoundError(err)) {
      throw new StoredImageProbeError('missing', 'stored image not found', { cause: err });
    }
    if (isRangeNotSatisfiableError(err)) {
      throw new StoredImageProbeError('unreadable', 'stored image is empty', { cause: err });
    }
    // `store-unavailable` is the only reason that is OUR fault, and the shapes it
    // collapses (missing credentials, bad endpoint, 5xx, a rejected Range) are
    // indistinguishable to the caller — so it is the one that has to be logged.
    logToAxiom({
      name: 'stored-image-probe',
      type: 'error',
      reason: 'store-unavailable',
      message: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : undefined,
      statusCode: (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode,
    }).catch(() => null);
    throw new StoredImageProbeError('store-unavailable', 'could not read the stored image', {
      cause: err,
    });
  }

  if (sizeBytes > maxBytes) {
    throw new StoredImageProbeError(
      'too-large',
      `stored image is ${sizeBytes} bytes (max ${maxBytes})`
    );
  }
  if (bytes.byteLength === 0)
    throw new StoredImageProbeError('unreadable', 'stored image is empty');

  const { default: sharp } = await import('sharp');
  let width: number | undefined;
  let height: number | undefined;
  let format: string | undefined;
  let orientation: number | undefined;
  try {
    ({ width, height, format, orientation } = await sharp(bytes).metadata());
  } catch (err) {
    throw new StoredImageProbeError('unreadable', 'stored image could not be decoded', {
      cause: err,
    });
  }
  if (!format || !width || !height || width <= 0 || height <= 0) {
    throw new StoredImageProbeError('unreadable', 'stored image has no readable dimensions');
  }

  // EXIF orientations 5-8 are quarter turns: the stored raster is transposed
  // relative to what every renderer shows, and the rules we measure against are
  // about the displayed image.
  const quarterTurned = orientation != null && orientation >= 5 && orientation <= 8;

  return {
    width: quarterTurned ? height : width,
    height: quarterTurned ? width : height,
    format,
    sizeBytes,
    etag,
  };
}

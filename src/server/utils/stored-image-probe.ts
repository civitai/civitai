import { GetObjectCommand } from '@aws-sdk/client-s3';

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

  constructor(reason: StoredImageProbeReason, message: string) {
    super(message);
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
};

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
  try {
    const { s3, bucket } = await getImageUploadBackend();
    const object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${maxBytes}` })
    );
    if (!object.Body) throw new StoredImageProbeError('unreadable', 'stored image has no body');
    bytes = Buffer.from(await object.Body.transformToByteArray());
    sizeBytes = parseTotalSize(object.ContentRange, bytes.byteLength);
  } catch (err) {
    if (err instanceof StoredImageProbeError) throw err;
    if (isNotFoundError(err)) throw new StoredImageProbeError('missing', 'stored image not found');
    if (isRangeNotSatisfiableError(err)) {
      throw new StoredImageProbeError('unreadable', 'stored image is empty');
    }
    throw new StoredImageProbeError('store-unavailable', 'could not read the stored image');
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
  } catch {
    throw new StoredImageProbeError('unreadable', 'stored image could not be decoded');
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
  };
}

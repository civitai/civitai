import { TRPCError } from '@trpc/server';

import {
  LISTING_ASSET_ALLOWED_MIME,
  LISTING_ASSET_FORMAT_TO_MIME,
} from '~/server/schema/blocks/app-listing.schema';

export type MeasuredUploadedImage = {
  width: number;
  height: number;
  mimeType: (typeof LISTING_ASSET_ALLOWED_MIME)[number];
  sizeBytes: number;
  /**
   * The store's entity tag for the object these values were measured from — the
   * evidence that lets a later consumer tell "still those bytes" from "was those
   * bytes once". `null` when the backend returned none; see
   * {@link classifyStoredObjectIntegrity}, which treats that as unverifiable.
   */
  etag: string | null;
};

/**
 * Measure the bytes already uploaded at `key` and return the values to persist on
 * the `Image` row, so `width` / `height` / `mimeType` / `metadata.size` describe
 * the object rather than what the uploader said about it.
 *
 * Every rule the listing attach procs apply (`validateListingImage`) is expressed
 * over exactly those four columns, and the attach gate is ownership-based — it
 * cannot tell how a row was created. So any path that lets a caller write them
 * makes all of those bounds self-reported, which is why the upload paths share
 * this instead of persisting the declared values.
 *
 * The guarantee is narrower than "the columns match the object": the presigned PUT
 * stays usable for its full expiry, so the same key can be overwritten after this
 * read. It says the values were true of real bytes AT PROBE TIME.
 *
 * `etag` is what a consumer needs to close that distance at ITS end: persisted
 * beside the measurement (under {@link STORED_OBJECT_ETAG_META_KEY}) it can be
 * re-checked against the live object at the point the measurement is actually
 * relied upon, so a row whose bytes were replaced afterwards is recognisable
 * rather than merely caveated.
 *
 * `maxBytes` bounds the read back out of the store AND rejects an object above it
 * (`subject` names the caller's media in that message). A decoded format outside
 * {@link LISTING_ASSET_FORMAT_TO_MIME} is rejected here rather than deferred,
 * because no consumer of a measured row accepts one.
 */
export async function measureUploadedImage(
  key: string,
  { maxBytes, subject }: { maxBytes: number; subject: string }
): Promise<MeasuredUploadedImage> {
  const { probeStoredImage, StoredImageProbeError } = await import(
    '~/server/utils/stored-image-probe'
  );

  let probe;
  try {
    probe = await probeStoredImage(key, { maxBytes });
  } catch (err) {
    if (!(err instanceof StoredImageProbeError)) throw err;
    if (err.reason === 'store-unavailable') {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: "We couldn't read that upload back to check it. Try again.",
      });
    }
    const message =
      err.reason === 'missing'
        ? "We couldn't find that upload — upload the image again."
        : err.reason === 'too-large'
        ? `that image is over the ${maxBytes / 1024 / 1024} MiB limit for ${subject}`
        : "That image couldn't be read. Try a different PNG, JPEG or WebP.";
    throw new TRPCError({ code: 'BAD_REQUEST', message });
  }

  const mimeType = LISTING_ASSET_FORMAT_TO_MIME[probe.format];
  if (!mimeType) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `unsupported image type "${
        probe.format
      }" (allowed: ${LISTING_ASSET_ALLOWED_MIME.join(', ')})`,
    });
  }
  return {
    width: probe.width,
    height: probe.height,
    mimeType,
    sizeBytes: probe.sizeBytes,
    etag: probe.etag,
  };
}

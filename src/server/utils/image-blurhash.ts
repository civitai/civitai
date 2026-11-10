import { encode } from 'blurhash';
import sharp from 'sharp';

import { logToAxiom } from '~/server/logging/client';

/**
 * The placeholder fields an on-site upload carries in `Image.metadata`: the browser computes
 * them before upload (`image.preprocessor.ts` → `createBlurHash`) and `MediaHash` needs all
 * three to draw the blurred placeholder while the real image loads.
 */
export type ImageBlurhash = {
  hash: string;
  /** Width as a viewer sees it — EXIF orientation applied, like the browser's `img.width`. */
  width: number;
  /** Height as a viewer sees it — EXIF orientation applied. */
  height: number;
};

/**
 * The longest side of the raster the hash is encoded from. Matches the browser path
 * (`getClampedSize(width, height, 64)` in `~/utils/blurhash`) and the server-side video
 * backfill, so a server-computed hash is the same shape as a client-computed one.
 */
const BLURHASH_MAX_SIDE = 64;
/** Component counts the browser path and the video backfill both encode with. */
const BLURHASH_COMPONENTS = 4;

/**
 * Compute the blurhash and the real pixel dimensions of an image from its bytes, server-side.
 *
 * For images that never pass through the browser preprocessor (App Block workflow outputs and
 * app-uploaded bytes), so their rows get the same `metadata.hash/width/height` an on-site upload
 * gets. Animated images are hashed from their first frame, as a browser `<img>` draws it.
 *
 * Throws when the bytes cannot be decoded; {@link tryComputeImageBlurhash} is the variant for a
 * caller that must not fail on it.
 */
export async function computeImageBlurhash(bytes: Buffer): Promise<ImageBlurhash> {
  const { width, height, orientation } = await sharp(bytes).metadata();
  if (!width || !height) throw new Error('image has no readable dimensions');

  // EXIF orientations 5-8 are quarter turns: the stored raster is transposed relative to what a
  // renderer shows (same rule as `stored-image-probe`).
  const quarterTurned = orientation != null && orientation >= 5 && orientation <= 8;

  const { data, info } = await sharp(bytes)
    .rotate() // apply EXIF orientation so the hash matches the displayed image
    .resize(BLURHASH_MAX_SIDE, BLURHASH_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const hash = encode(
    new Uint8ClampedArray(data),
    info.width,
    info.height,
    BLURHASH_COMPONENTS,
    BLURHASH_COMPONENTS
  );

  return {
    hash,
    width: quarterTurned ? height : width,
    height: quarterTurned ? width : height,
  };
}

/**
 * {@link computeImageBlurhash}, returning `null` (and logging) instead of throwing. A missing
 * placeholder is cosmetic, so a caller persisting an image uses this and carries on without one.
 */
export async function tryComputeImageBlurhash(
  bytes: Buffer,
  context: { source: string }
): Promise<ImageBlurhash | null> {
  try {
    return await computeImageBlurhash(bytes);
  } catch (err) {
    logToAxiom({
      name: 'image-blurhash',
      type: 'warning',
      source: context.source,
      message: err instanceof Error ? err.message : String(err),
    }).catch(() => null);
    return null;
  }
}

/**
 * The `Image.metadata` keys an on-site upload stores for its placeholder, or nothing when there
 * is no hash — so a row without one keeps the shape it had before.
 */
export function blurhashMetadata(
  blur: ImageBlurhash | null
): { hash: string; width: number; height: number } | Record<string, never> {
  return blur ? { hash: blur.hash, width: blur.width, height: blur.height } : {};
}

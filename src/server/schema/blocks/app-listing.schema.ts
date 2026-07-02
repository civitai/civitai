import * as z from 'zod';

/**
 * App Store Listings (W13) — P1 asset pipeline schemas + validation.
 *
 * The creator asset-management procs (`app-listings.router`) attach ALREADY-
 * ingested `Image` rows (uploaded through the site's standard media path) to an
 * `AppListing` as its icon / cover / ordered screenshots. Validation mirrors the
 * App Blocks E5 bundle-screenshot caps (count/size/type — see
 * `publish-request.schema.ts` MAX_SCREENSHOTS / MAX_SCREENSHOT_SIZE_BYTES /
 * SCREENSHOT_EXTENSIONS) and ADDS per-kind aspect + minimum-dimension caps a
 * store card/detail needs (square-ish icon, landscape cover).
 *
 * DARK / additive: nothing here is wired to a live read path or UI in P1. The
 * procs are owner/mod-gated behind the App Blocks flag.
 */

/** At most this many screenshots per listing (mirrors E5 MAX_SCREENSHOTS). */
export const MAX_LISTING_SCREENSHOTS = 8;

/** Per-asset byte caps. Screenshots mirror the E5 2 MiB cap; icon tighter, cover looser. */
export const MAX_LISTING_SCREENSHOT_SIZE_BYTES = 2 * 1024 * 1024; // 2 MiB
export const MAX_LISTING_ICON_SIZE_BYTES = 1 * 1024 * 1024; // 1 MiB
export const MAX_LISTING_COVER_SIZE_BYTES = 4 * 1024 * 1024; // 4 MiB

/**
 * Aspect (= width / height) + minimum-dimension caps per asset kind:
 *   - icon    — square-ish (a store avatar). Rejects wildly non-square images.
 *   - cover   — landscape hero (roughly 4:3 → 21:9).
 *   - screenshot — a real screen capture in either orientation, loosely bounded.
 */
export const LISTING_ICON_ASPECT_MIN = 0.9;
export const LISTING_ICON_ASPECT_MAX = 1.1;
export const LISTING_ICON_MIN_PX = 128;
export const LISTING_ICON_MAX_PX = 4096;

export const LISTING_COVER_ASPECT_MIN = 1.3; // ~4:3
export const LISTING_COVER_ASPECT_MAX = 2.4; // ~21:9
export const LISTING_COVER_MIN_WIDTH_PX = 640;

export const LISTING_SCREENSHOT_ASPECT_MIN = 0.4;
export const LISTING_SCREENSHOT_ASPECT_MAX = 2.6;
export const LISTING_SCREENSHOT_MIN_PX = 320;

/** Only real raster image MIME types (mirrors E5 SCREENSHOT_EXTENSIONS). */
export const LISTING_ASSET_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Max caption length (a one-line gallery caption, not markdown). */
export const LISTING_SCREENSHOT_CAPTION_MAX = 280;

export type ListingAssetKind = 'icon' | 'cover' | 'screenshot';

/** The subset of an `Image` row the validator inspects (kept pure + DB-free). */
export type ListingImageMeta = {
  /** MediaType — must be `image` (a video/audio asset is rejected). */
  type: string;
  width: number | null | undefined;
  height: number | null | undefined;
  /** Byte size (from `Image.metadata.size`) when known; unbounded when absent. */
  sizeBytes?: number | null;
  /** MIME type (from `Image.mimeType`) when known; unconstrained when absent. */
  mimeType?: string | null;
};

export type ValidateListingImageResult = { ok: true } | { ok: false; reason: string };

const KIND_SIZE_CAP: Record<ListingAssetKind, number> = {
  icon: MAX_LISTING_ICON_SIZE_BYTES,
  cover: MAX_LISTING_COVER_SIZE_BYTES,
  screenshot: MAX_LISTING_SCREENSHOT_SIZE_BYTES,
};

/**
 * Pure per-asset validation: a candidate `Image` must be a raster image of an
 * accepted MIME type, within the byte cap, with known positive dimensions that
 * satisfy the per-kind aspect + minimum-dimension bounds. Returns a structured
 * result (the caller maps `!ok` → a 400) rather than throwing so it's trivially
 * unit-testable. Size/MIME checks are SKIPPED only when the field is absent
 * (an older Image row may not carry `metadata.size` / `mimeType`) — never faked.
 */
export function validateListingImage(
  meta: ListingImageMeta,
  kind: ListingAssetKind
): ValidateListingImageResult {
  if (meta.type !== 'image') {
    return { ok: false, reason: `asset must be an image (got type "${meta.type}")` };
  }
  if (meta.mimeType != null && !LISTING_ASSET_ALLOWED_MIME.includes(meta.mimeType as never)) {
    return {
      ok: false,
      reason: `unsupported image type "${meta.mimeType}" (allowed: ${LISTING_ASSET_ALLOWED_MIME.join(', ')})`,
    };
  }
  const cap = KIND_SIZE_CAP[kind];
  if (meta.sizeBytes != null && meta.sizeBytes > cap) {
    return { ok: false, reason: `${kind} is ${meta.sizeBytes} bytes (max ${cap})` };
  }
  const { width, height } = meta;
  if (!width || !height || width <= 0 || height <= 0) {
    return { ok: false, reason: `${kind} has unknown or non-positive dimensions` };
  }
  const aspect = width / height;
  if (kind === 'icon') {
    const minSide = Math.min(width, height);
    const maxSide = Math.max(width, height);
    if (aspect < LISTING_ICON_ASPECT_MIN || aspect > LISTING_ICON_ASPECT_MAX) {
      return { ok: false, reason: `icon must be square-ish (aspect ${aspect.toFixed(2)} outside ${LISTING_ICON_ASPECT_MIN}–${LISTING_ICON_ASPECT_MAX})` };
    }
    if (minSide < LISTING_ICON_MIN_PX) {
      return { ok: false, reason: `icon must be at least ${LISTING_ICON_MIN_PX}px on its shorter side (got ${minSide}px)` };
    }
    if (maxSide > LISTING_ICON_MAX_PX) {
      return { ok: false, reason: `icon must be at most ${LISTING_ICON_MAX_PX}px on its longer side (got ${maxSide}px)` };
    }
  } else if (kind === 'cover') {
    if (aspect < LISTING_COVER_ASPECT_MIN || aspect > LISTING_COVER_ASPECT_MAX) {
      return { ok: false, reason: `cover must be landscape (aspect ${aspect.toFixed(2)} outside ${LISTING_COVER_ASPECT_MIN}–${LISTING_COVER_ASPECT_MAX})` };
    }
    if (width < LISTING_COVER_MIN_WIDTH_PX) {
      return { ok: false, reason: `cover must be at least ${LISTING_COVER_MIN_WIDTH_PX}px wide (got ${width}px)` };
    }
  } else {
    if (aspect < LISTING_SCREENSHOT_ASPECT_MIN || aspect > LISTING_SCREENSHOT_ASPECT_MAX) {
      return { ok: false, reason: `screenshot aspect ${aspect.toFixed(2)} is outside ${LISTING_SCREENSHOT_ASPECT_MIN}–${LISTING_SCREENSHOT_ASPECT_MAX}` };
    }
    if (Math.min(width, height) < LISTING_SCREENSHOT_MIN_PX) {
      return { ok: false, reason: `screenshot must be at least ${LISTING_SCREENSHOT_MIN_PX}px on its shorter side` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// tRPC input schemas (owner/mod-gated creator asset management).
// ---------------------------------------------------------------------------

const listingId = z.string().min(1).max(64);
const imageId = z.number().int().positive();
const caption = z.string().max(LISTING_SCREENSHOT_CAPTION_MAX).nullish();

export const listingAssetsQuerySchema = z.object({ listingId });
export type ListingAssetsQueryInput = z.infer<typeof listingAssetsQuerySchema>;

export const setListingIconSchema = z.object({ listingId, imageId });
export type SetListingIconInput = z.infer<typeof setListingIconSchema>;

export const setListingCoverSchema = z.object({ listingId, imageId });
export type SetListingCoverInput = z.infer<typeof setListingCoverSchema>;

export const addListingScreenshotSchema = z.object({ listingId, imageId, caption });
export type AddListingScreenshotInput = z.infer<typeof addListingScreenshotSchema>;

export const reorderListingScreenshotsSchema = z.object({
  listingId,
  // The full set of the listing's screenshot ids in the desired order.
  orderedIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_LISTING_SCREENSHOTS),
});
export type ReorderListingScreenshotsInput = z.infer<typeof reorderListingScreenshotsSchema>;

export const updateListingScreenshotCaptionSchema = z.object({
  screenshotId: z.string().min(1).max(64),
  caption,
});
export type UpdateListingScreenshotCaptionInput = z.infer<
  typeof updateListingScreenshotCaptionSchema
>;

export const removeListingScreenshotSchema = z.object({ screenshotId: z.string().min(1).max(64) });
export type RemoveListingScreenshotInput = z.infer<typeof removeListingScreenshotSchema>;

export const backfillListingAssetsSchema = z.object({
  // Cap at 50: a single mod tRPC mutation must not run for hours (autogen is
  // sequential with 45s verify-runner timeouts). Re-run the mutation to page.
  limit: z.number().int().min(1).max(50).optional(),
  dryRun: z.boolean().optional(),
});
export type BackfillListingAssetsInput = z.infer<typeof backfillListingAssetsSchema>;

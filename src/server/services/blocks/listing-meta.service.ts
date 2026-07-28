import { TRPCError } from '@trpc/server';

import { LISTING_ASSET_MAX_DIMENSION_PX } from '~/server/schema/blocks/app-listing.schema';
import { validateExternalUrl } from '~/server/schema/blocks/external-app.schema';
import type {
  FetchListingMetaInput,
  IngestListingAssetFromDataUriInput,
  IngestListingAssetFromUrlInput,
} from '~/server/schema/blocks/listing-meta.schema';
import { extractListingMeta, type ListingMetaSuggestion } from '~/server/utils/og-metadata';
import { SafeFetchError, safeFetch } from '~/server/utils/safe-fetch';

/**
 * App Store Listings (W13) — external-listing METADATA AUTO-PULL service.
 *
 * `fetchListingMeta` SSRF-safe-fetches the target page and returns SUGGESTIONS
 * (name / tagline / cover+icon image URLs) the author can accept or override;
 * nothing is persisted. `ingestListingAssetFromUrl` runs on ACCEPT: it
 * SSRF-safe-fetches the suggested image, uploads the bytes into the SAME image
 * store the browser-direct client upload path uses (the B2 image bucket +
 * storage-resolver registration, via `uploadImageBufferToStore` — NOT Cloudflare
 * Images, whose ids the scanner's edge URL never resolves), and materialises an
 * `Image` row through the STANDARD ingestion/scan pipeline (`createImage` with
 * default ingestion — NO `skipIngestion`, NO scan bypass), returning the numeric
 * `imageId` the client then attaches via `setIcon`/`setCover` (which enforce
 * `ingestion === Scanned` + per-kind validation).
 *
 * All outbound fetches go through `safeFetch` (lexical + DNS-resolve-public +
 * manual-redirect-revalidate + timeout + size cap + content-type allowlist). The
 * heavy deps (`createImage`, `sharp`, CF utils) are dynamically imported to keep
 * this module's static graph light (mirrors the router/offsite-service discipline).
 */

// ---------------------------------------------------------------------------
// Fetch budgets (SSRF controls). Mirror the bounded og-image-helpers pattern.
// ---------------------------------------------------------------------------

/** Page fetch: text/html only, ~1.5MB cap (plenty for a <head> full of OG tags), ~5s. */
export const META_HTML_TIMEOUT_MS = 5000;
export const META_HTML_MAX_BYTES = 1_500_000;

/** Image fetch: image/* only, 6MB cap (matches OG_IMAGE_MAX_BYTES), ~2.5s. */
export const META_IMAGE_TIMEOUT_MS = 2500;
export const META_IMAGE_MAX_BYTES = 6 * 1024 * 1024;

/** Allowed decoded image formats → their canonical listing-asset MIME types. */
const FORMAT_TO_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * Inline-icon (data-URI) ingest bounds. A favicon is small; cap the DECODED bytes
 * hard (independent of the schema's encoded-length gate — a highly-compressed blob
 * can still decode large) before handing anything to sharp. Also bound the
 * rasterized PNG's dimensions so an SVG with a huge intrinsic viewBox can't produce
 * an enormous canvas.
 */
export const INLINE_ICON_MAX_DECODED_BYTES = 2 * 1024 * 1024;
const INLINE_ICON_RASTER_MAX_PX = 1024;
/** MIME types accepted for an inline-icon data URI (mirrors the extractor allowlist). */
const INLINE_ICON_ALLOWED_MIME = new Set([
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

/** Generic, non-leaky message for any safe-fetch-layer failure. */
function friendlyFetchError(): TRPCError {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message:
      "We couldn't read that link's preview info. Check the URL, or add your name and images manually.",
  });
}

// ---------------------------------------------------------------------------
// fetchListingMeta (author) — page → suggestions.
// ---------------------------------------------------------------------------

/**
 * SSRF-safe-fetch the target page and extract suggested listing metadata. NEVER
 * throws on "nothing found" — a page with no usable tags returns `{}` (the UI
 * falls back to manual entry). SSRF / timeout / size / content-type / transport
 * failures map to a friendly `BAD_REQUEST` with no internal detail leaked.
 */
export async function fetchListingMeta(
  input: FetchListingMetaInput
): Promise<ListingMetaSuggestion> {
  // Lexical https-only gate first (the same single-source validator the submit
  // form uses) — a non-https / malformed URL is a user error, not a fetch failure.
  const url = validateExternalUrl(input.url);
  if (!url.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: url.error });

  let result;
  try {
    result = await safeFetch(url.url, {
      timeoutMs: META_HTML_TIMEOUT_MS,
      maxBytes: META_HTML_MAX_BYTES,
      allowedContentTypes: ['text/html', 'application/xhtml+xml'],
    });
  } catch (err) {
    if (err instanceof SafeFetchError) throw friendlyFetchError();
    throw err;
  }

  const html = result.bytes.toString('utf8');
  // Best-effort parse; an unparseable/empty page yields `{}` (not an error).
  return extractListingMeta(html, result.finalUrl);
}

// ---------------------------------------------------------------------------
// ingestListingAssetFromUrl (author) — accepted image URL → scannable Image row.
// ---------------------------------------------------------------------------

/**
 * Ingest an ACCEPTED suggested image URL into a scannable `Image` row. The remote
 * URL is attacker-influenced + cross-origin, so the SERVER pulls the bytes
 * (SSRF-safe) rather than the browser (CORS/SSRF-trust). Flow: safeFetch (image/*,
 * 6MB cap, 2.5s) → decode dimensions/format with sharp → upload the bytes to CF →
 * `createImage` (DEFAULT ingestion — the standard scan pipeline, NO bypass) →
 * return `{ imageId }`. The client then attaches via `setIcon`/`setCover` and polls
 * until the scan lands (reusing the existing asset-polling), exactly like an
 * author-uploaded asset. No listing binding here; ownership is the caller.
 */
export async function ingestListingAssetFromUrl(opts: {
  input: IngestListingAssetFromUrlInput;
  userId: number;
}): Promise<{ imageId: number }> {
  const { input, userId } = opts;

  let fetched;
  try {
    fetched = await safeFetch(input.url, {
      timeoutMs: META_IMAGE_TIMEOUT_MS,
      maxBytes: META_IMAGE_MAX_BYTES,
      allowedContentTypes: ['image/'],
    });
  } catch (err) {
    if (err instanceof SafeFetchError) throw friendlyFetchError();
    throw err;
  }

  // Decode the bytes to get authoritative dimensions + format (the Content-Type
  // header is untrusted). sharp is a heavy native dep → dynamic import.
  const { default: sharp } = await import('sharp');
  let width: number | undefined;
  let height: number | undefined;
  let format: string | undefined;
  try {
    const meta = await sharp(fetched.bytes).metadata();
    width = meta.width;
    height = meta.height;
    format = meta.format;
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: "That image couldn't be read. Try uploading it manually.",
    });
  }

  const mimeType = format ? FORMAT_TO_MIME[format] : undefined;
  if (!mimeType || !width || !height || width <= 0 || height <= 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Unsupported image type — upload a PNG, JPEG or WebP manually.',
    });
  }

  // Ceiling on either side — the byte cap alone doesn't bound decoded dimensions
  // (a tiny highly-compressed file can decode to an enormous canvas / bomb). Reject
  // before the CF upload + createImage scan pipeline.
  if (width > LISTING_ASSET_MAX_DIMENSION_PX || height > LISTING_ASSET_MAX_DIMENSION_PX) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `That image is too large (max ${LISTING_ASSET_MAX_DIMENSION_PX}px per side). Try uploading a smaller one manually.`,
    });
  }

  // Upload the ALREADY-FETCHED bytes into the SAME store the browser-direct client
  // upload path uses (the B2 image bucket, registered in storage-resolver) — NOT
  // Cloudflare Images. This is the load-bearing convergence: the edge URL
  // (`getEdgeUrl` → `NEXT_PUBLIC_IMAGE_LOCATION`) and the image scanner read from
  // this store, so the `Image.url` key below resolves at scan time and the row
  // reaches `Scanned`. (Uploading to CF Images instead — the original bug — left
  // these rows terminally `NotFound` because that store is never resolved here.)
  const { uploadImageBufferToStore } = await import('~/utils/s3-utils');
  const { key } = await uploadImageBufferToStore(fetched.bytes, { contentType: mimeType });

  // Materialise the Image row through the STANDARD scan pipeline (default
  // ingestion — no skipIngestion). Dynamic import keeps the heavy image.service
  // graph out of this module's static imports.
  const { createImage } = await import('~/server/services/image.service');
  const image = await createImage({
    url: key,
    name: `listing-${input.kind}`,
    type: 'image',
    width,
    height,
    mimeType,
    // The P1 image validator reads the byte size from `Image.metadata.size`.
    // `source`/`appListingAssetKind` stamp provenance so an OG-pulled asset is
    // auditable + query-able (e.g. the prod scan-verification check) — mirrors
    // `createStoredImage`.
    metadata: {
      size: fetched.bytes.byteLength,
      source: 'app-listing-og-pull',
      appListingAssetKind: input.kind,
    },
    userId,
  });

  return { imageId: image.id };
}

// ---------------------------------------------------------------------------
// ingestListingAssetFromDataUri (author) — accepted INLINE icon → PNG → Image row.
// ---------------------------------------------------------------------------

/**
 * Parse a `data:[<mime>][;base64],<data>` URI into its declared MIME + decoded
 * bytes. Returns `null` for anything that isn't a well-formed data URI. base64 and
 * percent-encoded (URL-encoded) payloads are both supported (an SVG favicon is
 * commonly URL-encoded). NEVER throws.
 */
function parseImageDataUri(dataUri: string): { mime: string; bytes: Buffer } | null {
  const m = /^data:([^,;]*)?(;[^,]*)?,(.*)$/is.exec(dataUri.trim());
  if (!m) return null;
  const mime = (m[1] || 'text/plain').toLowerCase().trim();
  const params = (m[2] || '').toLowerCase();
  const payload = m[3] ?? '';
  const isBase64 = /;base64/.test(params);
  try {
    const bytes = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    if (bytes.byteLength === 0) return null;
    return { mime, bytes };
  } catch {
    return null;
  }
}

/**
 * Ingest an ACCEPTED inline `data:image/...` icon (e.g. a favicon declared as a data
 * URI — radio.civitai.com) into a scannable `Image` row. This is a SEPARATE ingest
 * path from the URL fetch: the bytes come from the data URI itself (no outbound
 * fetch — never routed through safeFetch, which is https-only by design).
 *
 * 🔴 SECURITY — never store or serve raw SVG (SVG is an XSS vector). The flow:
 *   1. decode the data URI; REJECT any non-image MIME (`data:text/html`,
 *      `data:application/*`, scripts) — only `image/(svg+xml|png|jpeg|webp|gif)`;
 *   2. cap the DECODED byte size (decompression-abuse bound);
 *   3. RASTERIZE to PNG via sharp (SVG rasterizes through librsvg; a raster source
 *      is normalised too), bounding the output dimensions — so the bytes that ever
 *      reach the store are PNG, never SVG markup;
 *   4. upload the PNG into the SAME scannable image store the URL path uses →
 *      `createImage` through the STANDARD scan pipeline (no bypass) → `{ imageId }`.
 * The client then attaches via `setIcon` (polling until Scanned), exactly like an
 * author upload. Ownership is bound to the caller.
 */
export async function ingestListingAssetFromDataUri(opts: {
  input: IngestListingAssetFromDataUriInput;
  userId: number;
}): Promise<{ imageId: number }> {
  const { input, userId } = opts;

  const parsed = parseImageDataUri(input.dataUri);
  if (!parsed) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: "That icon couldn't be read. Try uploading it manually.",
    });
  }
  // Reject a non-image data URI (data:text/html / scripts / application/*). Only an
  // image MIME is ever rasterized + ingested.
  if (!INLINE_ICON_ALLOWED_MIME.has(parsed.mime)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Unsupported icon type — upload a PNG, JPEG or WebP manually.',
    });
  }
  // Cap the DECODED size (the encoded-length schema gate is coarse; a compressed
  // blob can still decode large). Bound before handing anything to sharp.
  if (parsed.bytes.byteLength > INLINE_ICON_MAX_DECODED_BYTES) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'That icon is too large. Try uploading a smaller one manually.',
    });
  }

  // Rasterize to PNG. This is the load-bearing security step: whatever the source
  // (SVG markup or a raster image), the bytes we STORE are always PNG — raw SVG is
  // never persisted or served. sharp reads an SVG via librsvg; `resize(...inside)`
  // bounds the output canvas so a huge intrinsic viewBox can't bomb the pipeline.
  const { default: sharp } = await import('sharp');
  let png: Buffer;
  let width: number | undefined;
  let height: number | undefined;
  try {
    png = await sharp(parsed.bytes, { density: 96 })
      .resize({
        width: INLINE_ICON_RASTER_MAX_PX,
        height: INLINE_ICON_RASTER_MAX_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    const meta = await sharp(png).metadata();
    width = meta.width;
    height = meta.height;
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: "That icon couldn't be read. Try uploading it manually.",
    });
  }
  if (!width || !height || width <= 0 || height <= 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: "That icon couldn't be read. Try uploading it manually.",
    });
  }

  // Upload the RASTERIZED PNG into the SAME scannable store the URL path uses (B2
  // image bucket + storage-resolver) — the edge URL + scanner resolve it.
  const { uploadImageBufferToStore } = await import('~/utils/s3-utils');
  const { key } = await uploadImageBufferToStore(png, { contentType: 'image/png' });

  const { createImage } = await import('~/server/services/image.service');
  const image = await createImage({
    url: key,
    name: `listing-${input.kind}`,
    type: 'image',
    width,
    height,
    mimeType: 'image/png',
    metadata: {
      size: png.byteLength,
      source: 'app-listing-og-pull-datauri',
      appListingAssetKind: input.kind,
    },
    userId,
  });

  return { imageId: image.id };
}

import { TRPCError } from '@trpc/server';

import { validateExternalUrl } from '~/server/schema/blocks/external-app.schema';
import type {
  FetchListingMetaInput,
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
 * SSRF-safe-fetches the suggested image, uploads the bytes to Cloudflare, and
 * materialises an `Image` row through the STANDARD ingestion/scan pipeline
 * (`createImage` with default ingestion — NO `skipIngestion`, NO scan bypass),
 * returning the numeric `imageId` the client then attaches via `setIcon`/`setCover`
 * (which enforce `ingestion === Scanned` + per-kind validation).
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

  // Upload the ALREADY-FETCHED bytes to Cloudflare (never re-fetch the remote URL).
  const { uploadBufferToCF } = await import('~/utils/cf-images-utils');
  const ext = mimeType.split('/')[1] ?? 'img';
  const uploaded = await uploadBufferToCF(fetched.bytes, `listing-asset.${ext}`, {
    userId,
    source: 'app-listing-og-pull',
    kind: input.kind,
  });

  // Materialise the Image row through the STANDARD scan pipeline (default
  // ingestion — no skipIngestion). Dynamic import keeps the heavy image.service
  // graph out of this module's static imports.
  const { createImage } = await import('~/server/services/image.service');
  const image = await createImage({
    url: uploaded.id,
    name: `listing-${input.kind}`,
    type: 'image',
    width,
    height,
    mimeType,
    // The P1 image validator reads the byte size from `Image.metadata.size`.
    metadata: { size: fetched.bytes.byteLength },
    userId,
  });

  return { imageId: image.id };
}

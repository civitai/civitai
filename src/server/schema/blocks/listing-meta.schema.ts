import * as z from 'zod';

import { MAX_EXTERNAL_URL_LENGTH } from '~/server/schema/blocks/external-app.schema';

/**
 * App Store Listings (W13) — external-listing METADATA AUTO-PULL schemas.
 *
 * Two author-gated procs back the submit-form auto-pull:
 *   - `fetchListingMetaFromUrl` — SSRF-safe server fetch of the target page →
 *     suggested name/tagline + cover/icon image URLs (SUGGESTIONS only, not
 *     persisted).
 *   - `ingestListingAssetFromUrl` — on ACCEPT, SSRF-safe server fetch of a
 *     suggested image URL → CF upload → `Image` row via the STANDARD scan
 *     pipeline (createImage default ingestion). Returns the numeric `imageId`
 *     the client then attaches via `setIcon`/`setCover` (polling until Scanned).
 *
 * Both `url` inputs are bound loose here (length only); the https-only /
 * DNS-resolved-public SSRF validation is enforced in the SERVICE via `safeFetch`,
 * NOT the schema — a lexically-valid https URL can still resolve to a private
 * address, so validation must happen at fetch time.
 */

/** Fetch page metadata for the submit form's URL step. */
export const fetchListingMetaSchema = z.object({
  url: z.string().min(1).max(MAX_EXTERNAL_URL_LENGTH),
});
export type FetchListingMetaInput = z.infer<typeof fetchListingMetaSchema>;

/** Ingest an accepted suggested image URL into a scannable Image row. */
export const ingestListingAssetFromUrlSchema = z.object({
  url: z.string().min(1).max(MAX_EXTERNAL_URL_LENGTH),
  /**
   * Which asset the author is accepting this image for. Advisory only — it is
   * recorded in the CF metadata; the per-kind dimension/mime/aspect validation is
   * enforced authoritatively by the `setIcon`/`setCover` attach procs, not here.
   */
  kind: z.enum(['icon', 'cover']),
});
export type IngestListingAssetFromUrlInput = z.infer<typeof ingestListingAssetFromUrlSchema>;

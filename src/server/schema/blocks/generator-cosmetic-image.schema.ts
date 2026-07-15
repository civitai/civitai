import * as z from 'zod';

/**
 * Custom Generators (Phase-2a PR-C) — the generator BUILDER's cosmetic-background
 * image upload bridge (`OPEN_IMAGE_UPLOAD`). This is the PUBLIC cosmetic image a
 * generator shows behind its form, so — unlike an app-listing asset (mod-reviewed
 * before it is ever visible) — it MUST route through the REAL scan pipeline AND a
 * hard SFW content ceiling before its id is handed back to the (untrusted) block.
 *
 * Two session-authed procs back the host modal:
 *   - persistImage — materialise a CF-uploaded image into a scannable `Image` row
 *     (real `createImage` + `ingestImage`, NO trust-stamp / NO `createStoredImage`).
 *   - gateImage    — poll the scan result, gate pending/scanned/blocked + enforce
 *     the SFW ceiling, and only then return the moderated id + rating + url.
 */

// Mirrors persistListingAssetImageSchema — the CF upload key + intrinsic dims the
// scanner + validators need. The generator builder uploads via the SAME
// `useCFImageUpload` path as the listing asset step, so the shape is identical.
export const persistGeneratorCosmeticImageSchema = z.object({
  // The CF upload key returned by `useCFImageUpload` — imageSchema requires a uuid.
  url: z.string().uuid(),
  name: z.string().max(255).nullish(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mimeType: z.string().max(120).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type PersistGeneratorCosmeticImageInput = z.infer<
  typeof persistGeneratorCosmeticImageSchema
>;

export const gateGeneratorCosmeticImageSchema = z.object({
  imageId: z.number().int().positive(),
});
export type GateGeneratorCosmeticImageInput = z.infer<typeof gateGeneratorCosmeticImageSchema>;

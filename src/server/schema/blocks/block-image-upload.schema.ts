import * as z from 'zod';

/**
 * App Blocks (Phase-2a PR-C) — the host-mediated, session-authed block image-upload
 * bridge (`OPEN_IMAGE_UPLOAD`). A sandboxed block asks the host to let the user
 * upload an image (avatar / cover / background / reference / whatever the app is
 * for); the platform's only guarantee is a MODERATED image. Unlike an app-listing
 * asset (mod-reviewed before it is ever visible), a block displays this image
 * PUBLICLY with no prior review, so it MUST route through the REAL scan pipeline
 * AND a hard SFW + no-moderation-flag gate before its id is handed back to the
 * (untrusted) block.
 *
 * Two session-authed procs back the host modal:
 *   - persist — materialise a CF-uploaded image into a scannable `Image` row
 *     (real `createImage` + `ingestImage`, NO trust-stamp / NO `createStoredImage`).
 *   - gate    — poll the scan result, gate pending/scanned/blocked + enforce the
 *     SFW ceiling + reject moderation-flagged images, and only then return the
 *     moderated id + rating + url.
 */

/**
 * 🔴 `width` / `height` / `mimeType` / `sizeBytes` are NOT persisted. The server
 * reads the uploaded object back and measures all four, because a row created here
 * is attachable as app-listing media — `loadValidatedImage` gates on ownership, not
 * on provenance — and the listing geometry/size/MIME bounds are expressed over
 * exactly those columns, which nothing else re-derives (issue #3770). The guarantee
 * is "measured from real bytes at persist time", NOT "still true of the object":
 * the presigned PUT stays usable for its full expiry, so the key can be overwritten
 * afterwards. They stay in the contract as optional so clients that still send them
 * keep working.
 */
export const persistBlockUploadImageSchema = z.object({
  // The CF upload key returned by `useCFImageUpload` — imageSchema requires a uuid.
  url: z.string().uuid(),
  name: z.string().max(255).nullish(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  mimeType: z.string().max(120).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type PersistBlockUploadImageInput = z.infer<typeof persistBlockUploadImageSchema>;

export const gateBlockUploadImageSchema = z.object({
  imageId: z.number().int().positive(),
});
export type GateBlockUploadImageInput = z.infer<typeof gateBlockUploadImageSchema>;

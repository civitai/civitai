import * as z from 'zod';
import { OFFSITE_MOD_REASON_MIN } from '~/server/schema/blocks/offsite-moderation.schema';

/**
 * Schemas for the App Blocks W1 publish-request flow.
 *
 * `submitVersion` is the developer-facing mutation that uploads a ZIP
 * bundle (the entire app directory) for moderator review. v0 accepts the
 * bundle as a base64-encoded string inside the tRPC JSON body — simpler
 * than multipart parsing or presigned-URL choreography, and 50MB max is
 * comfortably below typical Next.js body limits.
 *
 * Phase 4 may revisit this with a direct-to-S3 presigned PUT flow if the
 * 33% base64 overhead becomes a bottleneck. v0 prioritizes shipping.
 */

export const SLUG_REGEX = /^[a-z][a-z0-9-]*[a-z0-9]$/;
export const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const MAX_BUNDLE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MiB
export const MAX_FILES_IN_BUNDLE = 2000;
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB per file
// Ceiling on TOTAL decompressed bytes across all entries in a bundle.
// Defends against zip bombs: MAX_FILES_IN_BUNDLE * MAX_FILE_SIZE_BYTES is
// ~20 GiB, far past what a pod can hold. 4x the 50 MiB upload cap is well
// above any legitimate web bundle's decompressed size yet bounds memory.
export const MAX_TOTAL_DECOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MiB

// F-E E5 marketplace screenshot gallery caps. Screenshots are PUBLISHER-SUPPLIED
// images (an abuse vector), so they get their own tighter caps ON TOP OF the
// generic bundle caps above:
//   - count: a gallery, not a dumping ground — extra entries are REJECTED (not
//     silently truncated) so a publisher can't smuggle payload files past the
//     reviewer's eye by burying them past a truncation point.
//   - per-file size: 2 MiB is generous for a screenshot but well under the
//     10 MiB generic per-file cap, bounding the public-image storage + bandwidth.
// Both are enforced in extractScreenshots (publish-request.service.ts); a test
// FAILS if either cap is removed.
export const MAX_SCREENSHOTS = 8;
export const MAX_SCREENSHOT_SIZE_BYTES = 2 * 1024 * 1024; // 2 MiB per screenshot
// Only these extensions are accepted under screenshots/ — and each file's BYTES
// must additionally match the corresponding image magic-bytes signature (the
// extension alone is NOT trusted). webp validation also confirms the RIFF...WEBP
// container, jpeg the SOI marker, png the 8-byte signature.
export const SCREENSHOT_EXTENSIONS = ['png', 'webp', 'jpg', 'jpeg'] as const;
export type ScreenshotExtension = (typeof SCREENSHOT_EXTENSIONS)[number];
// The reserved bundle dir screenshots live under. Anything else is ignored.
export const SCREENSHOT_DIR = 'screenshots/';

export const submitVersionSchema = z.object({
  // Base64-encoded ZIP bytes. Server decodes, validates size, then
  // extracts manifest.blockId / manifest.version / manifest.name as the
  // canonical slug / version / display name for this submission. There
  // are no separate form fields for those — the manifest is the source
  // of truth, and the form would otherwise just be a typo trap that
  // produces "blockId X does not match form slug Y" errors.
  bundleBase64: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_BUNDLE_SIZE_BYTES * 4) / 3) + 16),
});

export type SubmitVersionInput = z.infer<typeof submitVersionSchema>;

export const withdrawRequestSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});

export type WithdrawRequestInput = z.infer<typeof withdrawRequestSchema>;

export const getMyPendingForSlugSchema = z.object({
  slug: z.string().min(3).max(40).regex(SLUG_REGEX),
});

export type GetMyPendingForSlugInput = z.infer<typeof getMyPendingForSlugSchema>;

export const listPendingRequestsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(64).optional(),
});

export type ListPendingRequestsInput = z.infer<typeof listPendingRequestsSchema>;

// History tabs share the same paginate-by-cursor shape — reuse the schema
// rather than fork it. The router exposes them as distinct procs so future
// per-status filters (e.g. by reviewer) can diverge without breaking the
// pending queue.
export const listApprovedRequestsSchema = listPendingRequestsSchema;
export type ListApprovedRequestsInput = z.infer<typeof listApprovedRequestsSchema>;

export const listRejectedRequestsSchema = listPendingRequestsSchema;
export type ListRejectedRequestsInput = z.infer<typeof listRejectedRequestsSchema>;

export const approveRequestSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
  approvalNotes: z.string().max(2000).optional(),
});

export type ApproveRequestInput = z.infer<typeof approveRequestSchema>;

/**
 * On-site reject-reason floor, unified with the shared moderator-reason minimum
 * (`OFFSITE_MOD_REASON_MIN`, 3) so it matches every other mod-reason field on
 * /apps/review and the client gate agrees with the server schema (was a magic 10).
 */
export const PUBLISH_REJECTION_REASON_MIN = OFFSITE_MOD_REASON_MIN;
export const PUBLISH_REJECTION_REASON_MAX = 2000;

export const rejectRequestSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
  rejectionReason: z
    .string()
    .min(PUBLISH_REJECTION_REASON_MIN)
    .max(PUBLISH_REJECTION_REASON_MAX),
});

export type RejectRequestInput = z.infer<typeof rejectRequestSchema>;

/** Input for the MOD-ONLY `blocks.getPublishRequestScreenshots` (F-E E5 review). */
export const getPublishRequestScreenshotsSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});

export type GetPublishRequestScreenshotsInput = z.infer<
  typeof getPublishRequestScreenshotsSchema
>;

/** Input for the MOD-ONLY `blocks.getPublishRequestDiff` (line-level code diff). */
export const getPublishRequestDiffSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});

export type GetPublishRequestDiffInput = z.infer<typeof getPublishRequestDiffSchema>;

/** Input for the MOD-ONLY review-sandbox `blocks.previewRequest` /
 *  `blocks.getReviewStatus` (#2831). */
export const previewRequestSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});

export type PreviewRequestInput = z.infer<typeof previewRequestSchema>;

export const getReviewStatusSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});

export type GetReviewStatusInput = z.infer<typeof getReviewStatusSchema>;

/** Input for the MOD-ONLY review-sandbox `blocks.mintReviewBlockToken` (#2831) —
 *  mints the self-bound, scope-stripped block token the on-site review preview
 *  host handshakes with. Same shape as previewRequest (the pending request id). */
export const mintReviewBlockTokenSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});

export type MintReviewBlockTokenInput = z.infer<typeof mintReviewBlockTokenSchema>;

/** Input for the MOD-ONLY agentic code-review `blocks.startAgentReview` (P1) —
 *  dispatches an ephemeral review agent for a PENDING request. Same shape as
 *  previewRequest (the pending request id). */
export const startAgentReviewSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});

export type StartAgentReviewInput = z.infer<typeof startAgentReviewSchema>;

export const teardownPreviewSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});

export type TeardownPreviewInput = z.infer<typeof teardownPreviewSchema>;

export const backfillPublishRequestSchema = z.object({
  slug: z.string().min(3).max(40).regex(SLUG_REGEX),
  approvalNotes: z.string().max(2000).optional(),
});

export type BackfillPublishRequestInput = z.infer<typeof backfillPublishRequestSchema>;

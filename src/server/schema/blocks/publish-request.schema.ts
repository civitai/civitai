import * as z from 'zod';

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

export const submitVersionSchema = z.object({
  slug: z.string().min(3).max(40).regex(SLUG_REGEX),
  version: z.string().regex(SEMVER_REGEX, 'version must be semver (e.g. 0.1.0)'),
  // Base64-encoded ZIP bytes. Server decodes and validates size before
  // touching it (the encoded length cap below is a quick pre-check; the
  // post-decode buffer is checked against MAX_BUNDLE_SIZE_BYTES).
  //
  // Display name + marketplace description come from the manifest at v0
  // (manifest.name + manifest.description). The Phase 4 form pre-fills
  // them from a manifest preview before the dev clicks submit, so there
  // are no separate form fields.
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

export const listPendingRequestsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(64).optional(),
});

export type ListPendingRequestsInput = z.infer<typeof listPendingRequestsSchema>;

export const approveRequestSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
  approvalNotes: z.string().max(2000).optional(),
});

export type ApproveRequestInput = z.infer<typeof approveRequestSchema>;

export const rejectRequestSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
  rejectionReason: z.string().min(10).max(2000),
});

export type RejectRequestInput = z.infer<typeof rejectRequestSchema>;

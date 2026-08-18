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
  // #4059 build provenance. Both OPTIONAL: a client that sends neither submits
  // exactly as it did before this existed, and this must never become a submit
  // gate — an author whose tooling predates it, or who builds outside a git
  // checkout, still ships.
  //
  // ── WIRE CONTRACT ──────────────────────────────────────────────────────────
  // These are the THREE answers a client can give, and only three:
  //
  //   omit the key entirely         → UNKNOWN
  //   send the key as JSON `null`   → UNKNOWN  (the same answer, spelled twice)
  //   send a value                  → the claim
  //
  // and for `sourceDirty` the value half is itself two DIFFERENT answers:
  //   `false` = the client asserted the tree was CLEAN
  //   `true`  = the client asserted the tree was DIRTY
  // `false` is a claim, not an absence. Never collapse it into UNKNOWN, and
  // never `?? false` an UNKNOWN into it — the tri-state is the feature.
  //
  // 🔴 `.nullish()`, NOT `.optional()`. `.optional()` accepts `undefined` only,
  // and JSON has no `undefined` — so a client encoding UNKNOWN the natural way,
  // as `{"sourceDirty": null}`, had its WHOLE SUBMIT rejected with a 400, and
  // for `sourceCommit` that 400 read "must be a 40-character lowercase hex git
  // commit sha", which is wrong about what happened. That is precisely the
  // submit gate this field is forbidden to be. Measured against zod 4.0.17.
  //
  // The `?? undefined` normalisation is load-bearing, not tidying: it is what
  // keeps a `null` off the Prisma `create` data. Prisma OMITS an `undefined`
  // field from the INSERT but emits an explicit `NULL` for a `null` one — the
  // resulting ROW is identical either way, but the SQL is not, and an explicit
  // NULL would make EVERY provenance-less submit name the new columns, turning
  // the migration-ordering hazard (see the migration header) from conditional
  // into unconditional. `SubmitVersionParams` types both as `?: T` and never
  // `| null`, so the seam cannot quietly drift back.
  // ───────────────────────────────────────────────────────────────────────────
  //
  // 🔴 UNTRUSTED CLIENT CLAIM. The server validates the SHAPE and stores the
  // value; it CANNOT confirm the uploaded bundle was actually built from this
  // commit, and a client is free to send a sha it never built from. Nothing
  // downstream — UI, API, CLI — may render or describe these as verified. They
  // are a diagnosis aid for deploy-vs-source drift, not an attestation.
  //
  // 🔴 NOT `forgejoCommitSha`, which this row also carries. That one is
  // SERVER-side, written on approve after the platform's own Forgejo commit
  // succeeded — a fact about a different repository. Never alias, default, or
  // fall back between the two.
  //
  // A malformed value REJECTS the request rather than being dropped. Zod's
  // default object mode strips unknown keys silently, which is exactly how a
  // provenance-sending client would look like it worked while storing nothing —
  // the inert-feature shape this field exists to close. So the regex is a hard
  // 400: lowercase 40-hex only (git's own canonical rendering; accepting
  // uppercase too would mean the same commit is two distinct strings in the
  // column and a lookup has to normalise).
  sourceCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullish()
    .transform((v) => v ?? undefined),
  // Whether the client's work tree had uncommitted changes at build time.
  // Tri-state at rest: absent/null = UNKNOWN, false = the client asserted CLEAN,
  // true = the client asserted DIRTY. `false` and `null` are DIFFERENT answers
  // and stay distinguishable end to end — do not `?? false` this anywhere.
  sourceDirty: z
    .boolean()
    .nullish()
    .transform((v) => v ?? undefined),
});

export type SubmitVersionInput = z.infer<typeof submitVersionSchema>;

/**
 * Per-field hints for a `submitVersionSchema` rejection. Only the #4059
 * provenance fields appear here, on purpose — see below.
 */
const SUBMIT_VERSION_FIELD_HINTS: Record<string, string> = {
  sourceCommit: 'sourceCommit must be a 40-character lowercase hex git commit sha',
  sourceDirty: 'sourceDirty must be a boolean',
};

/** The message both submit routes have always returned for a parse failure. */
export const INVALID_BUNDLE_MESSAGE = 'Invalid bundle payload';

/**
 * Render a `submitVersionSchema` parse failure as a message that NAMES the field
 * that failed.
 *
 * 🔴 Why this exists: both submit routes answered EVERY parse failure with the
 * flat `'Invalid bundle payload'`. Once the schema also validates provenance, a
 * client whose `sourceCommit` was the wrong shape would be told its BUNDLE was
 * bad and go hunting the zip — the diagnosis cost this feature exists to remove,
 * re-created one layer up.
 *
 * Genuine bundle failures are UNCHANGED: any issue touching `bundleBase64`
 * (or an unrecognised path, e.g. a non-object body) still yields exactly
 * `INVALID_BUNDLE_MESSAGE`, so nothing that used to read that string reads
 * something else now. Only a failure confined to the provenance fields gets the
 * named message.
 *
 * One copy, called from both routes: the predicate was open-coded at two call
 * sites already and would have drifted at the next edit.
 */
export function submitVersionParseErrorMessage(error: z.ZodError): string {
  const fields = new Set(
    error.issues.map((issue) => (typeof issue.path[0] === 'string' ? issue.path[0] : ''))
  );
  const named = [...fields].filter((f) => f in SUBMIT_VERSION_FIELD_HINTS);
  // A bundle problem (or anything unrecognised) wins — bundle behaviour is frozen.
  if (named.length === 0 || named.length !== fields.size) return INVALID_BUNDLE_MESSAGE;
  return `Invalid submit payload: ${named
    .sort()
    .map((f) => SUBMIT_VERSION_FIELD_HINTS[f])
    .join('; ')}`;
}

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

/**
 * Input for the MOD-ONLY `blocks.retriggerBuild` — re-fire the Tekton build for
 * an ALREADY-APPROVED request whose build never started (or failed).
 *
 * `publishRequestId` is the ONLY field, and that is load-bearing: the commit sha
 * to rebuild is read from the DB row, NEVER supplied by the caller. Accepting a
 * sha here would let a moderator rebuild + deploy an ARBITRARY commit that was
 * never reviewed. Keeping the sha off the wire makes that structurally
 * impossible rather than merely validated-against.
 */
export const retriggerBuildSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});

export type RetriggerBuildInput = z.infer<typeof retriggerBuildSchema>;

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

/** Input for the MOD-ONLY `blocks.getPublishRequest` — single-request fetch that
 *  powers the per-submission review PAGE (`/apps/review/<publishRequestId>`). */
export const getPublishRequestSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});

export type GetPublishRequestInput = z.infer<typeof getPublishRequestSchema>;

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
  /**
   * MOD REVIEW SANDBOX "run for real" (#2831). Default false → the render-only
   * sandbox (byte-identical to today). When true, the mod has EXPLICITLY opted in
   * (behind a loud client consent gate) to run the unapproved app for real against
   * their OWN account; the server re-mints a wider, still-clamped, still-self-bound,
   * still-forced-SFW token with a per-call budget + an aggregate session Buzz cap.
   * The opt-in is authorized + rate-limited server-side regardless of this flag.
   */
  runForReal: z.boolean().optional().default(false),
});

export type MintReviewBlockTokenInput = z.infer<typeof mintReviewBlockTokenSchema>;

/** Input for the MOD-ONLY agentic code-review `blocks.startAgentReview` (P1) —
 *  dispatches an ephemeral review agent for a PENDING request. Same shape as
 *  previewRequest (the pending request id). */
export const startAgentReviewSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});

export type StartAgentReviewInput = z.infer<typeof startAgentReviewSchema>;

/** Input for the MOD-ONLY agentic code-review READ path `blocks.getAgentReview`
 *  (P2) — the poll + render source for the report of a PENDING request. Same
 *  shape as previewRequest (the pending request id). */
export const getAgentReviewSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});

export type GetAgentReviewInput = z.infer<typeof getAgentReviewSchema>;

/** One turn of the MOD-ONLY in-modal agent chat (P3). The CLIENT sends the
 *  running conversation; the server prepends its own grounding system context. */
export const agentReviewChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4000),
});

export type AgentReviewChatMessage = z.infer<typeof agentReviewChatMessageSchema>;

/** Input for the MOD-ONLY in-modal agent chat proxy `blocks.agentReviewChat`
 *  (P3). The client sends the pending request id + the running conversation
 *  (bounded); the server prepends a grounding system message and proxies to the
 *  review agent pod's in-cluster gateway. */
export const agentReviewChatSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
  messages: z.array(agentReviewChatMessageSchema).min(1).max(20),
});

export type AgentReviewChatInput = z.infer<typeof agentReviewChatSchema>;

export const teardownPreviewSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});

export type TeardownPreviewInput = z.infer<typeof teardownPreviewSchema>;

export const backfillPublishRequestSchema = z.object({
  slug: z.string().min(3).max(40).regex(SLUG_REGEX),
  approvalNotes: z.string().max(2000).optional(),
});

export type BackfillPublishRequestInput = z.infer<typeof backfillPublishRequestSchema>;

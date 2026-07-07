import * as z from 'zod';

/**
 * App Store Listings (W13) — P3b OFF-SITE MODERATION schemas.
 *
 * The user-facing REPORT affordance + the mod-facing report-queue read. Kept in a
 * DEDICATED schema module (parallel to the P3a `offsite-listing.schema`) so the
 * post-approval moderation surface (report now; delist / relist / claim in PR3)
 * stays cleanly separated from the submission lifecycle.
 *
 * Imports ONLY zod, so this module is safe to pull into the client bundle (the
 * report modal + its pure view-model reuse the reason tuple as the single source
 * of truth — the CHECK constraint in the migration `.sql` is the DB-layer mirror).
 *
 * The reason / status tuples MUST match the CHECK constraints applied in
 * `prisma/migrations/20260706120050_w13_p3b_app_listing_reports/migration.sql`:
 *   reason IN (impersonation, phishing-malware, broken, inappropriate, spam, other)
 *   status IN (pending, resolved, dismissed)
 * A drift here would let the proc write a value the DB rejects (23514). A unit
 * test pins the tuple against those documented values.
 */

/** Report reasons — MUST equal the `app_listing_reports_reason_check` CHECK set. */
export const APP_LISTING_REPORT_REASONS = [
  'impersonation',
  'phishing-malware',
  'broken',
  'inappropriate',
  'spam',
  'other',
] as const;
export type AppListingReportReason = (typeof APP_LISTING_REPORT_REASONS)[number];

/** Report lifecycle — MUST equal the `app_listing_reports_status_check` CHECK set. */
export const APP_LISTING_REPORT_STATUSES = ['pending', 'resolved', 'dismissed'] as const;
export type AppListingReportStatus = (typeof APP_LISTING_REPORT_STATUSES)[number];

/** Free-text elaboration bound (mirrors the off-site description/changelog bound). */
export const OFFSITE_REPORT_DETAILS_MAX = 2000;

/**
 * USER report of an approved off-site listing.
 *
 * `appListingId` is the target listing id (`apl_<ULID>`); the reporter is ALWAYS
 * bound to `ctx.user.id` in the service (there is NO reporter field here — a
 * caller can never file a report as someone else). `reason` is validated against
 * the shared tuple (the CHECK mirror); `details` is optional + bounded.
 */
export const reportListingSchema = z.object({
  appListingId: z.string().min(1).max(64),
  reason: z.enum(APP_LISTING_REPORT_REASONS),
  details: z.string().max(OFFSITE_REPORT_DETAILS_MAX).optional(),
});
export type ReportListingInput = z.infer<typeof reportListingSchema>;

/**
 * MOD keyset-paginate the report queue. Optional `status` filter (default: the
 * whole queue; the queue UI passes `pending`); FIFO oldest-first in the service.
 * `limit` is capped at 50 (a smaller page than the submission queues — a report
 * row carries the reporter chip + target listing projection).
 */
export const listListingReportsSchema = z.object({
  status: z.enum(APP_LISTING_REPORT_STATUSES).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type ListListingReportsInput = z.infer<typeof listListingReportsSchema>;

// ---------------------------------------------------------------------------
// P3b PR3 — mod ACTIONS (delist / relist / purge / resolve / dismiss) + the
// per-listing moderation-history read.
// ---------------------------------------------------------------------------

/**
 * Moderation-event action taxonomy — MUST equal the `app_listing_mod_events_action_check`
 * CHECK set (migration `20260706120100_w13_p3b_app_listing_moderation_events`). A
 * drift here would let a proc write an `action` the DB rejects (23514). The
 * action-agreement unit test pins this tuple against the migration's IN-list.
 *
 * NOTE the hyphen form (`report-resolve`/`report-dismiss`) — it matches the
 * shipped migration CHECK verbatim. `claim` is reserved for PR4 (not written by
 * any PR3 proc), but stays in the tuple because the DB CHECK already allows it.
 */
export const APP_LISTING_MODERATION_ACTIONS = [
  'delist',
  'relist',
  'claim',
  'purge',
  'report-resolve',
  'report-dismiss',
] as const;
export type AppListingModerationAction = (typeof APP_LISTING_MODERATION_ACTIONS)[number];

/**
 * Bounds for the mod-supplied rationale (`reason`, REQUIRED on delist/relist/purge)
 * and the optional resolution `note` (resolve/dismiss). The reason is the audit
 * trail's human record of WHY a takedown happened, so a small non-empty floor is
 * enforced (mirrors the reject-reason discipline, lighter).
 */
export const OFFSITE_MOD_REASON_MIN = 3;
export const OFFSITE_MOD_REASON_MAX = 1000;
export const OFFSITE_MOD_NOTE_MAX = 1000;

const modReason = z.string().min(OFFSITE_MOD_REASON_MIN).max(OFFSITE_MOD_REASON_MAX);
const modNote = z.string().max(OFFSITE_MOD_NOTE_MAX).optional();

/**
 * MOD delist an APPROVED off-site listing (approved → removed). `reason` is
 * required (audit); `reportId` optionally links the report that triggered the
 * takedown (resolved in the same tx). The reviewer is bound to `ctx.user.id` in
 * the service — never supplied by the client.
 */
export const delistListingSchema = z.object({
  appListingId: z.string().min(1).max(64),
  reason: modReason,
  reportId: z.string().min(1).max(64).optional(),
});
export type DelistListingInput = z.infer<typeof delistListingSchema>;

/** MOD relist a REMOVED off-site listing (removed → approved). Reversibility. */
export const relistListingSchema = z.object({
  appListingId: z.string().min(1).max(64),
  reason: modReason,
});
export type RelistListingInput = z.infer<typeof relistListingSchema>;

/**
 * MOD claim (reassign ownership of) an off-site listing (PR4) — mod-arbitrated
 * ownership transfer of an `approved` OR `removed` off-site listing to a
 * mod-verified owner. `targetUserId` is the numeric id of the NEW owner (a real
 * `User`, validated in the service); `reason` is the required ownership-verification
 * audit note. The reviewer (the acting mod) is bound to `ctx.user.id` in the service
 * — never client-supplied. There is NO self-service / `protectedProcedure` claim
 * endpoint: a mod is the whole trust boundary (a mod MAY reassign to any real user,
 * including resolving an impersonation by re-pointing to the verified owner).
 *
 * `reportId` optionally links the report that triggered the claim (the substantive
 * resolution of an impersonation report → delist → claim → ban flow) — resolved in
 * the same tx, listing-scoped, exactly like `delistListingSchema.reportId`.
 */
export const claimListingSchema = z.object({
  appListingId: z.string().min(1).max(64),
  targetUserId: z.number().int().positive(),
  reason: modReason,
  reportId: z.string().min(1).max(64).optional(),
});
export type ClaimListingInput = z.infer<typeof claimListingSchema>;

/**
 * MOD hard-delete (purge) an off-site listing — the final expunge that also makes
 * the delist round-trip self-cleaning. Destructive: the UI gates it behind a
 * confirm. `reason` required for the audit event (which SURVIVES the delete via
 * the SetNull FK + the denormalized slug snapshot).
 */
export const purgeListingSchema = z.object({
  appListingId: z.string().min(1).max(64),
  reason: modReason,
});
export type PurgeListingInput = z.infer<typeof purgeListingSchema>;

/** MOD resolve a PENDING report (pending → resolved). Optional resolution note. */
export const resolveReportSchema = z.object({
  reportId: z.string().min(1).max(64),
  note: modNote,
});
export type ResolveReportInput = z.infer<typeof resolveReportSchema>;

/** MOD dismiss a PENDING report (pending → dismissed; no action taken). */
export const dismissReportSchema = z.object({
  reportId: z.string().min(1).max(64),
  note: modNote,
});
export type DismissReportInput = z.infer<typeof dismissReportSchema>;

/** MOD per-listing moderation-history read (keyset, newest-first). */
export const listModerationEventsSchema = z.object({
  appListingId: z.string().min(1).max(64),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type ListModerationEventsInput = z.infer<typeof listModerationEventsSchema>;

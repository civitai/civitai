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

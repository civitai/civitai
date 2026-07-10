/**
 * App Store Listings (W13) — canonical AppListing.status set.
 *
 * SINGLE SOURCE OF TRUTH for the `app_listings.status` lifecycle values in the
 * CODE. Stored in the FREE-TEXT `app_listings.status` column (NOT a Postgres
 * enum) — the allowed set is enforced by a DB CHECK constraint that lives ONLY
 * in the migration `.sql` (Prisma cannot express CHECK constraints).
 *
 * 🔴 This const MUST stay in lockstep with the `app_listings_status_check`
 * CHECK in the migrations. The migration-agreement unit test
 * (`__tests__/app-listing-status.constants.test.ts`) parses the latest
 * status-CHECK `.sql` and asserts its IN-list EQUALS this array — so a drift
 * ("the code writes a status the CHECK forbids") is caught in CI, standing in
 * for the human rule-#8 manual-apply step.
 *
 * P0 shipped `draft|pending|approved|rejected`
 * (`prisma/migrations/20260701120000_w13_p0_app_listing/migration.sql`).
 * P3b adds `removed` (the delist target) — see
 * `claudedocs/app-blocks-p3b-delist-claim-scope-2026-07-06.md`.
 */
export const APP_LISTING_STATUSES = [
  'draft',
  'pending',
  'approved',
  'rejected',
  'removed',
] as const;

export type AppListingStatus = (typeof APP_LISTING_STATUSES)[number];

/** Type guard — is the given value one of the known listing statuses. */
export function isAppListingStatus(value: unknown): value is AppListingStatus {
  return (
    typeof value === 'string' && (APP_LISTING_STATUSES as readonly string[]).includes(value)
  );
}

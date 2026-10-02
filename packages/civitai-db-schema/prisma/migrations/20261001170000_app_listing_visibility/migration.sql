-- ============================================================
-- App Store Listings — per-listing VISIBILITY LEVEL (W14)
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are run by hand — see CLAUDE.md -> Database.
-- There is no `prisma migrate deploy` path and `_prisma_migrations` is not the source of
-- truth; a HUMAN applies the statements below per environment. Apply to BOTH:
--   1. the production primary (the live civitai DB)
--   2. the dev clone, BEFORE any preview smoke run, or the preview 500s on the column
--
-- APPLY THIS **BEFORE** DEPLOYING THE CODE. THERE IS A HARD ORDERING CONSTRAINT, and it
-- is the same one `20260823120000_app_listing_source_repo` learned the expensive way and
-- `20260901120000_app_listing_beta` restated.
--
-- Prisma returns the created/updated row, so it emits
-- `INSERT/UPDATE ... RETURNING <every scalar the MODEL declares>`. `visibility` is
-- declared on the `AppListing` model, so the generated SQL names it whether or not the key
-- appears in `data` — and the same is true of any call that RETURNS ROWS and passes no
-- explicit `select`: `findUnique` / `findFirst` / `findMany` / `create` / `update` /
-- `upsert` / `delete`, and the `...AndReturn` variants. There are many of those on this
-- model. `updateMany` / `deleteMany` / `createMany` return a row COUNT, so they name no
-- scalars in the RETURNING list — but they still name whatever columns appear in their own
-- `data` and `where`, so an `appListing.updateMany({ data: { visibility } })` raises 42703
-- exactly like the rest.
--
-- Deploying the code first therefore turns an additive feature into a public-store outage:
--
--     HTTP 500 — The column `app_listings.visibility` does not exist in the current database.
--
-- NO TEST IN THIS REPO CAN SEE THAT. The suites mock Prisma, so none of them generates
-- SQL. `app-listing-visibility.service.ts` is defence in depth for the paths that DO pass
-- an explicit select (and the store list path refuses to NAME the column until an
-- availability probe says it is there); it is not, and cannot be, a substitute for running
-- this first.
--
-- `ADD COLUMN ... NOT NULL DEFAULT 'private'` does NOT rewrite the table on PG 11+ (the
-- default is stored in the catalog and materialised on read), so statement 1 is
-- catalog-only and O(1) regardless of row count. Run these outside a long-running
-- transaction so they cannot queue behind (or in front of) reads.
--
-- `IF NOT EXISTS` / `DROP ... IF EXISTS` so a re-run, or an environment where a human
-- already applied part of this, is a no-op rather than an error.
--
-- ------------------------------------------------------------
-- THE BACKFILL IS PER STATUS, NOT ONE BLANKET DEFAULT
-- ------------------------------------------------------------
-- Measured population at authoring time: draft 18, removed 17, approved 16, pending 0.
--
--   * `approved`                    -> 'public'.  These rows are ALREADY reachable by
--     everyone the surface flags admit, so `public` is the only value that truthfully
--     describes them. Leaving them at the `private` default would make the column assert
--     the opposite of the live behaviour — which the owner-facing editor reads back, and
--     which any future change that lets a level NARROW an approved listing would act on.
--   * `draft` / `pending`           -> 'private' (the column default). Not reachable in
--     the store today; `private` preserves that exactly, so the merge is a no-op.
--   * `rejected` / `removed`        -> 'private' (the column default). Both are negative
--     moderation outcomes. `private` is truthful AND fail-closed, and the code's
--     eligibility allowlist (`VISIBILITY_ELIGIBLE_LISTING_STATUSES`) refuses them anyway,
--     so neither a level nor a backfill can partially un-take-down an app.
--
-- Only the `approved` rows therefore need statement 2; every other status is already
-- correct by virtue of the default.
--
-- The CHECK's IN-list is kept in lockstep with the code constant
-- `APP_LISTING_VISIBILITIES` by the migration-agreement test
-- `src/server/services/blocks/__tests__/app-listing-visibility.constants.test.ts`, which
-- parses THIS file. That catches code/DDL drift in CI; it does NOT apply the DDL.

-- 1. The column. Catalog-only on PG 11+.
ALTER TABLE "app_listings"
  ADD COLUMN IF NOT EXISTS "visibility" TEXT NOT NULL DEFAULT 'private';

-- 2. Per-status backfill. Only `approved` diverges from the default; see above.
UPDATE "app_listings" SET "visibility" = 'public' WHERE "status" = 'approved';

-- 3. The allowed set. Postgres cannot modify a CHECK in place, so DROP then ADD, wrapped
--    in one transaction: without it there is a sub-ms window with no CHECK at all through
--    which a concurrent bad write could slip. Mirrors
--    `20260706120200_w13_p3b_app_listing_status_add_removed`.
BEGIN;
ALTER TABLE "app_listings" DROP CONSTRAINT IF EXISTS "app_listings_visibility_check";
ALTER TABLE "app_listings" ADD  CONSTRAINT "app_listings_visibility_check"
  CHECK ("visibility" IN ('private', 'moderators', 'testers', 'public'));
COMMIT;

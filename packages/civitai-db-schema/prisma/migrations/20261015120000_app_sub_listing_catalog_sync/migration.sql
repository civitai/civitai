-- ============================================================
-- App Store sub-listings — catalog sync onto an OFF-SITE parent
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database):
-- there is no `prisma migrate deploy` path. A human runs this file against the main civitai
-- database (the one holding `app_sub_listing_parents`), dev first, then production. It needs
-- `20261010120000_app_sub_listings` applied first.
--
-- Safe in either order with the code deploy: until applied, the catalog endpoints
-- (`/api/v1/catalog/items*`) answer 503 and off-site children stay out of the store; on-site
-- children are unaffected.
--
-- ADDITIVE ONLY. One nullable column with a CHECK on `app_sub_listing_parents`; no row changes.
-- Idempotent (`IF NOT EXISTS`), so a re-run is a no-op.
--
-- `link_template` is the https URL an off-site parent's store cards open, with exactly one
-- `{id}` that is replaced by the item's id. Only an off-site parent uses it, and the store shows
-- an off-site parent's children only while it is set. It is set by hand, per parent.
--
-- LOCKS. Adding a nullable column without a default is a catalog-only change, but it takes an
-- ACCESS EXCLUSIVE lock on `app_sub_listing_parents`, and the CHECK is validated by scanning it.
-- While the lock is held or queued, the store's sub-listing read waits. `lock_timeout` caps the
-- wait at 3s: on `canceling statement due to lock timeout` nothing was applied (one
-- transaction); wait and re-run.
--
-- ROLLBACK (drops every parent's link template; off-site children then leave the store and the
-- catalog endpoints answer 503 again):
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   ALTER TABLE "app_sub_listing_parents" DROP COLUMN IF EXISTS "link_template";
--   COMMIT;
--
-- The CHECK is kept in lockstep with `isValidSubListingLinkTemplate` by
-- `src/server/services/blocks/__tests__/app-sub-listing.constants.test.ts`, which parses this
-- file.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "app_sub_listing_parents"
  ADD COLUMN IF NOT EXISTS "link_template" TEXT
    CONSTRAINT "app_sub_listing_parents_link_template_check" CHECK (
      "link_template" IS NULL OR (
        "link_template" ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?/'
        AND char_length("link_template") <= 300
        AND (char_length("link_template") - char_length(replace("link_template", '{id}', ''))) = 4));

COMMIT;

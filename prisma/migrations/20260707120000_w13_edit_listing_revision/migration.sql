-- ============================================================
-- App Store Listings (W13) — edit-listing revision (shadow-draft) support
-- ============================================================
-- Adds a self-referential `revision_of_id` to app_listings so an author can EDIT
-- an already-APPROVED (LIVE) listing without withdrawing it: a hidden DRAFT clone
-- (the "shadow") of the live listing is created with revision_of_id = <parent id>,
-- edited via the existing asset/field procs, and on mod re-approve its contents
-- are copied onto the live parent (which keeps its id/slug/app_block_id/metrics/
-- reports); the shadow is then deleted. On reject/withdraw the shadow is deleted
-- and the live parent is untouched. See
-- claudedocs/app-blocks-app-store-listings-plan-2026-07-01.md and the
-- "edit external listing without withdraw" scope.
--
-- draft/pending listings are edited IN PLACE (no shadow); only an approved
-- listing's MATERIAL edit (external_url / name / assets) routes through a shadow.
--
-- ON DELETE CASCADE: deleting a parent app_listing cascades its in-flight shadow
-- (a shadow is meaningless without its parent). Screenshots of the shadow are in
-- turn cascaded by the existing app_listing_screenshots FK.
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations (no prisma migrate deploy). This
-- file is committed for HISTORY ONLY; a HUMAN applies the SQL below per
-- environment (psql/retool). CI / deploy do NOT run it. Apply to BOTH, BEFORE the
-- release that carries this code (a revision write hits the missing column
-- otherwise):
--   1. prod nvme0   (the live civitai DB)
--   2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev, db civitai) — apply
--      before the PR preview smoke runs, or the preview 500s on the missing column.
--
-- Additive + idempotent: IF NOT EXISTS on the column + index, and the FK is
-- guarded by a DO block, so a manual re-run is a no-op. The column is NULLABLE
-- (existing rows are all top-level listings, revision_of_id = NULL) so the ADD
-- COLUMN is an instant metadata-only change (no table rewrite / no lock storm).

ALTER TABLE "app_listings"
  ADD COLUMN IF NOT EXISTS "revision_of_id" TEXT;

-- Self-referential FK: a shadow points at its live parent. ON DELETE CASCADE so a
-- parent delete removes its in-flight shadow. Guarded so a manual re-run is inert.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_listings_revision_of_id_fkey'
  ) THEN
    ALTER TABLE "app_listings"
      ADD CONSTRAINT "app_listings_revision_of_id_fkey"
      FOREIGN KEY ("revision_of_id") REFERENCES "app_listings"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- Index the FK: the shadow-lookup (WHERE revision_of_id = <parent>) + the read
-- path's defense-in-depth `revision_of_id IS NULL` filter both scan on it, and
-- Postgres does NOT auto-index a FK (so a parent DELETE would seq-scan otherwise).
CREATE INDEX IF NOT EXISTS "app_listings_revision_of_idx"
  ON "app_listings" ("revision_of_id");

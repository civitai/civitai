-- ============================================================
-- F-E E5 — App Blocks marketplace screenshot gallery
-- ============================================================
-- See claudedocs/app-platform-fe-marketplace-plan-2026-06-14.md (Phase E5,
-- design decision #2).
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations. This file is committed for
-- history; a HUMAN applies the SQL below per environment (psql/retool). CI /
-- deploy does NOT run it.
--
-- ⚠️ MUST BE APPLIED BEFORE THE E5 CODE GOES LIVE: `getAppDetail` (the dark,
-- mod-gated detail-page read) SELECTs `ab.screenshots` unconditionally. If the
-- code is live before this column exists, that query 500s (same constraint as
-- E3's `category`). The CI/preview build does NOT query it (the build doesn't
-- run getAppDetail; the anon smoke hits the mod-gated detail page → notFound,
-- so getAppDetail never runs), so the build passes without the column — but
-- the live detail page would 500. Apply this first.
--
-- ADDITIVE + NON-BREAKING + IDEMPOTENT:
--   - One nullable jsonb column; existing rows and existing INSERTs (which never
--     mention it) are unaffected. Defaults to NULL → "no screenshots".
--   - `IF NOT EXISTS` so re-applying is a no-op.
--   - No index needed: screenshots are only read on the single-row getAppDetail
--     path (keyed on the PK), never filtered/sorted on.

ALTER TABLE "app_blocks"
  ADD COLUMN IF NOT EXISTS "screenshots" jsonb;

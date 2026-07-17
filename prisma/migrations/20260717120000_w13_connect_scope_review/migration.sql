-- ============================================================
-- W13 — OAuth-connect app-listing scope review + per-scope justifications
-- ============================================================
-- See claudedocs/oauth-app-scope-review-plan-2026-07-17.md (§1). PR1 (dark
-- groundwork): additive schema only — nothing reads these columns yet. PR2
-- (dev authoring) and PR3 (mod review) will write/read them.
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations. This file is committed for
-- history; a HUMAN applies the SQL below per environment (psql/retool). CI /
-- deploy does NOT run it.
--
-- ⚠️ MUST BE APPLIED BEFORE THE PR2/PR3 CODE GOES LIVE: the authoring service
-- and the mod-review submissionSelect will SELECT/INSERT these columns. If that
-- code ships before the columns exist, those queries 500 (same missing-column
-- constraint as E5's `screenshots` / E3's `category`). PR1 itself references
-- nothing, so it is safe to deploy ahead of this apply — but PR2/PR3 are NOT.
-- Apply this first.
--
-- ADDITIVE + NON-BREAKING + IDEMPOTENT:
--   - Two nullable columns; existing rows and existing INSERTs (which never
--     mention them) are unaffected. Both default to NULL:
--       * connect_requested_scopes  = "no scope review" (external-link/on-site)
--       * connect_scope_justifications = "no justifications"
--   - `IF NOT EXISTS` so re-applying is a no-op.
--   - No index needed: read only on the single-row listing/review paths (keyed
--     on the PK), never filtered/sorted on.

ALTER TABLE "app_listings"
  ADD COLUMN IF NOT EXISTS "connect_requested_scopes" integer,
  ADD COLUMN IF NOT EXISTS "connect_scope_justifications" jsonb;

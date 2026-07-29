-- ============================================================
-- App Blocks — off-site (external-link) apps
-- ============================================================
-- PURE EXTERNAL LINK product model: a marketplace listing that just opens an
-- external URL in a new tab — NO install, NO scopes, NO block token, NO
-- subscription, NO on-platform iframe/page hosting. Presence of `external_url`
-- is the discriminator (no separate appType enum).
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations. This file is committed for
-- history; a HUMAN applies the SQL below per environment (psql/retool). CI /
-- deploy does NOT run it.
--
-- ADDITIVE + NON-BREAKING:
--   - A single nullable column, so existing rows and existing INSERTs (which
--     don't mention it) are unaffected — NULL = a normal on-platform app.
--   - No index needed: the column is read per-row on the already-filtered
--     marketplace listing / detail paths, never used as a filter predicate.
--   - `IF NOT EXISTS` makes the apply idempotent (re-runnable, safe online).

ALTER TABLE "app_blocks"
  ADD COLUMN IF NOT EXISTS "external_url" TEXT;

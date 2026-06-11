-- ============================================================================
-- OAuth Dynamic Client Registration (RFC 7591) support fields.
-- ============================================================================
-- Adds two columns to "OauthClient":
--   isDynamicallyRegistered  — true for clients created via the open /register
--                              endpoint. Used by the GC job to scope cleanup of
--                              stale, never-used DCR clients (and by the consent
--                              screen to show the "not verified" warning).
--   lastUsedAt               — last time a token was issued/used for this client.
--                              Nullable; informational + future GC tuning.
--
-- Both are additive and backfill safely (defaults), so this is non-blocking on
-- a live table.
--
-- !!! MANUAL APPLY REQUIRED !!!
-- Per CLAUDE.md, migrations are NOT auto-run (no `prisma migrate deploy`).
-- A human must run this SQL directly against each target DB (preview / staging
-- / prod) via psql / retool / cnpg superuser. Do not rely on _prisma_migrations.
-- ============================================================================

ALTER TABLE "OauthClient"
  ADD COLUMN IF NOT EXISTS "isDynamicallyRegistered" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3);

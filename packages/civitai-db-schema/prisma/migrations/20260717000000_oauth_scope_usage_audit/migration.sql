-- Unified scope-usage audit — extend `block_scope_invocations` to ALSO record
-- EXTERNAL OAuth API usage (standard OAuth access tokens), not just App-Block
-- block-tokens. The two token populations exercise the SAME civitai scopes;
-- this table becomes the single "which app used which scope, when" record for
-- both, keyed on a `source` discriminator.
--
-- What this adds:
--   * `oauth_client_id` (nullable TEXT) — the acting OauthClient (the app) for an
--     external-OAuth invocation. Intentionally FK-LESS so the audit row SURVIVES
--     deletion of the OauthClient it references (an audit trail must outlive the
--     app). NULL for a block-token row (which uses `app_block_id`).
--   * `source` (TEXT NOT NULL DEFAULT 'app-block') — discriminates 'app-block'
--     (block-token) vs 'external-oauth' (OAuth access token) invocations. The
--     DEFAULT backfills every existing row to 'app-block', so no block-token
--     record changes meaning.
--   * `block_instance_id` → NULLABLE — an external-OAuth row has no block instance
--     (the acting app is a pure OauthClient with no App Block).
--   * `bsi_oauth_client_invoked_idx` — supports a future per-OAuth-app activity
--     read (oauth_client_id, invoked_at DESC), mirroring bsi_app_block_invoked_idx.
--
-- Additive + backward-compatible: nullable/defaulted columns, no data rewrite of
-- existing semantics. Every existing row keeps app_block_id/block_instance_id and
-- gets source = 'app-block'.
--
-- MANUAL APPLY ONLY: the main civitai DB (CNPG nvme0) does NOT auto-apply Prisma
-- migrations. Apply this SQL by hand to the target env; _prisma_migrations is not
-- the source of truth here. Safe to run in or out of a transaction — the ADD
-- COLUMN ... DEFAULT is a metadata-only rewrite on modern Postgres, and dropping a
-- NOT NULL is metadata-only.

ALTER TABLE "block_scope_invocations"
  ADD COLUMN IF NOT EXISTS "oauth_client_id" TEXT,
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'app-block';

ALTER TABLE "block_scope_invocations"
  ALTER COLUMN "block_instance_id" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "bsi_oauth_client_invoked_idx"
  ON "block_scope_invocations" ("oauth_client_id", "invoked_at" DESC);

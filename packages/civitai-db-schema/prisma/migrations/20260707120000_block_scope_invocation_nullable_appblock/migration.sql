-- App Dev Tunnel Phase 2 — durable per-spend audit for PRE-APPROVAL dev-tunnel spends.
--
-- A pre-approval app has NO AppBlock row (moderator approval is what creates it),
-- so its scoped dev token carries a SYNTHETIC `ephemeral-<slug>` app_block_id that
-- can never FK-resolve. Today recordScopeInvocation's INSERT FK-fails on that value
-- and the error is swallowed, so a pre-approval Buzz spend leaves NO durable audit
-- row (only a log line). This migration makes `app_block_id` NULLABLE and adds
-- `synthetic_app_id` so the audit row PERSISTS for that case (app_block_id NULL,
-- synthetic_app_id = the synthetic dev ref).
--
-- Additive + backward-compatible: every existing / approved-app row keeps its real
-- app_block_id FK value and a NULL synthetic_app_id. The FK is preserved (ON DELETE
-- CASCADE unchanged) — a nullable FK column simply skips the check for NULL rows.
--
-- MANUAL APPLY ONLY: the main civitai DB (CNPG nvme0) does NOT auto-apply Prisma
-- migrations. Apply this SQL by hand to the target env; _prisma_migrations is not
-- the source of truth here.

ALTER TABLE "block_scope_invocations"
  ALTER COLUMN "app_block_id" DROP NOT NULL;

ALTER TABLE "block_scope_invocations"
  ADD COLUMN IF NOT EXISTS "synthetic_app_id" TEXT;

-- Applied MANUALLY per civitai rule #8. Run this statement OUTSIDE a transaction (psql without --single-transaction): CONCURRENTLY cannot run in a txn. The two ALTERs above are metadata-only and safe in or out of a txn.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "bsi_synthetic_app_invoked_idx"
  ON "block_scope_invocations" ("synthetic_app_id", "invoked_at" DESC) WHERE "synthetic_app_id" IS NOT NULL;

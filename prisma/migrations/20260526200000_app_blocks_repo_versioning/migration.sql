-- ============================================================
-- App Blocks W2-v0 Phase 4 — Repo-versioning columns on app_blocks
-- ============================================================
-- Adds three columns that track the Forgejo / apps-as-repos pipeline:
--
--   * current_version_sha          — commit SHA currently deployed at
--                                    <slug>.apps.civitaic.com
--   * current_version_deployed_at  — when the apply Job succeeded
--   * repo_url                     — public URL of the Forgejo repo (UI
--                                    deep-link from /apps/installed,
--                                    /apps/submit success state)
--
-- All three are nullable: rows that pre-date W2 (hackathon block at
-- apb_01KSD3NP23CQE4TMW14XTEFSNS) won't have these populated until the
-- W12 migration of the existing block onto the new pipeline. The
-- webhook handler in src/pages/api/internal/blocks/git-push.ts writes
-- current_version_sha; build-callback.ts writes current_version_deployed_at.
--
-- Manual application (per CLAUDE.md gotcha #14):
--   kubectl exec -i -n cnpg-database cnpg-cluster-nvme0-N -- psql \
--     -U postgres -d civitai -v ON_ERROR_STOP=1 --single-transaction \
--     < prisma/migrations/20260526200000_app_blocks_repo_versioning/migration.sql

ALTER TABLE "app_blocks"
  ADD COLUMN IF NOT EXISTS "current_version_sha" TEXT,
  ADD COLUMN IF NOT EXISTS "current_version_deployed_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "repo_url" TEXT;

-- For ops queries — "what's deployed where?". Partial-index on rows that
-- have a deployed sha to keep it small.
CREATE INDEX IF NOT EXISTS "app_blocks_current_version_sha_idx"
  ON "app_blocks" ("current_version_sha")
  WHERE "current_version_sha" IS NOT NULL;

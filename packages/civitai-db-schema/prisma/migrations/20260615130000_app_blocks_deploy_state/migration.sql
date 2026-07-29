-- App Blocks Phase 2: per-request build/deploy lifecycle for /apps/my-submissions.
-- Additive + nullable → backward-compatible, safe to apply ahead of the rollout.
-- civitai applies migrations MANUALLY (no `prisma migrate deploy`) — apply to
-- prod cnpg-nvme0 AND the cnpg-cluster-dev clone.
ALTER TABLE "app_block_publish_requests"
  ADD COLUMN IF NOT EXISTS "deploy_state" TEXT,
  ADD COLUMN IF NOT EXISTS "deploy_detail" TEXT,
  ADD COLUMN IF NOT EXISTS "deploy_updated_at" TIMESTAMPTZ(6);

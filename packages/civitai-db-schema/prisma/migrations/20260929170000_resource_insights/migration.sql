-- ResourceInsight — Jev-assigned meaning labels for published model versions.
--
-- Apply this MANUALLY, per environment, BEFORE running the labeling pass
-- (scripts/label-resource-insights.ts). We do not use `prisma migrate deploy`
-- anywhere; this file exists for review/history. Re-runnable: every statement
-- is guarded with IF NOT EXISTS / DO blocks.
--
-- One row per ModelVersion (1:1, FK cascade on version delete). The write path
-- is a batched offline job — no hot-path writes — so plain CREATE TABLE +
-- btree indexes; there is no insertion-order or access-pattern reason for
-- anything fancier.
--
-- `role` / `styleFamily` / `contentTypes` are TEXT rather than Postgres enums:
-- their value sets are versioned with the question spec (specHash on every
-- row), and a DB enum would turn every taxonomy tune into a hand-applied
-- ALTER TYPE on every environment. Readers validate against the app-side
-- schema instead. `specHash` + `stale` are the expand/contract pair: a spec
-- bump flips existing rows `stale = true` (re-label queue) rather than
-- rewriting them in place, so the old labels stay queryable while the new
-- spec's rows arrive.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "ResourceInsight" (
    "modelVersionId" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "styleFamily" TEXT NOT NULL,
    "contentTypes" TEXT[] NOT NULL,
    "qualityScore" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "specHash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stale" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ResourceInsight_pkey" PRIMARY KEY ("modelVersionId")
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ResourceInsight_modelVersionId_fkey'
    ) THEN
        ALTER TABLE "ResourceInsight" ADD CONSTRAINT "ResourceInsight_modelVersionId_fkey"
            FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ResourceInsight_stale_idx" ON "ResourceInsight"("stale");

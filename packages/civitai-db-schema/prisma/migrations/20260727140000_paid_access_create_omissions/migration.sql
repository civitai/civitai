-- Fixes two omissions in 20260725134836_create_paid_access: the `timeframeDays` column and the
-- `[entityType, endsAt]` index — both declared in schema.prisma and relied on by the code, but never
-- created. All additive + rollback-safe. Apply immediately after create_paid_access and BEFORE the
-- phase-1 code deploys.

-- 1) timeframeDays: the pre-publish timed-window length, materialized into endsAt at publish
--    (NULL = permanent). getPaidAccess SELECTs it and writePaidAccessForModelVersion writes it, so
--    WITHOUT this column every PaidAccess read/write errors on the missing column.
ALTER TABLE "PaidAccess" ADD COLUMN IF NOT EXISTS "timeframeDays" INTEGER;

-- Backfill the window length for rows create_paid_access already inserted (timed gates only;
-- permanent gates correctly keep NULL). Regex guard makes the ::int cast safe. Idempotent.
UPDATE "PaidAccess" pa
SET "timeframeDays" = (mv."earlyAccessConfig" ->> 'timeframe')::int
FROM "ModelVersion" mv
WHERE pa."entityType" = 'ModelVersion'
  AND pa."entityId" = mv.id
  AND pa."timeframeDays" IS NULL
  AND pa."endsAt" IS NOT NULL -- timed gates only; permanent (endsAt NULL) stays NULL
  AND (mv."earlyAccessConfig" ->> 'timeframe') ~ '^[0-9]+$';

-- 2) [entityType, endsAt] index: the expiry job (process-ending-early-access, every ~1 min) and the
--    early-access-complete notification both scan `WHERE endsAt <= NOW()`. Without this they seq-scan
--    PaidAccess. Plain CREATE INDEX is fine here (PaidAccess holds only gated entities — small); if the
--    table is large when you apply this, run CREATE INDEX CONCURRENTLY instead (outside a transaction).
CREATE INDEX IF NOT EXISTS "PaidAccess_entityType_endsAt_idx" ON "PaidAccess"("entityType", "endsAt");

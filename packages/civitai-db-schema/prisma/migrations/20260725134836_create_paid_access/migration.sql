-- Part 1 of the paid-access refactor: the PaidAccess table (config side of the gate).
-- Behavior-preserving: bundle semantics kept, no independent grants. Applied manually.
-- See docs/creator-studio/paid-access-schema.md and paid-access-implementation.md.
--
-- DEPLOY ORDER: run this backfill BEFORE the read-flip (file.service etc.) ships. Otherwise a
-- currently-gated version read before its row exists caches as "free" for up to the cache TTL.

-- CreateEnum
CREATE TYPE "PaidAccessEntityType" AS ENUM ('ModelVersion', 'ComicChapter');

-- CreateTable
CREATE TABLE "PaidAccess" (
    "entityType" "PaidAccessEntityType" NOT NULL,
    "entityId"   INTEGER NOT NULL,
    "ownerId"    INTEGER NOT NULL,
    "endsAt"     TIMESTAMP(3),
    "terms"      JSONB NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaidAccess_pkey" PRIMARY KEY ("entityType", "entityId")
);

-- CreateIndex: general owner-scoped range/active queries (matches the schema @@index)
CREATE INDEX "PaidAccess_ownerId_entityType_endsAt_idx" ON "PaidAccess"("ownerId", "entityType", "endsAt");

-- CreateIndex: partial index for the permanent cap count (Prisma can't express a partial index in-schema)
CREATE INDEX "PaidAccess_permanent_cap_idx" ON "PaidAccess"("ownerId", "entityType") WHERE "endsAt" IS NULL;

-- Backfill: CURRENTLY-GATED model versions only. Permanent -> endsAt NULL; else the timed end.
-- terms mirror today's bundle config: download = full-access tier, generation = optional cheaper tier,
-- freeGeneration preserved. (Comics migrates onto PaidAccess in a later stage.)
INSERT INTO "PaidAccess" ("entityType", "entityId", "ownerId", "endsAt", "terms", "updatedAt")
SELECT
    'ModelVersion',
    mv.id,
    m."userId",
    CASE WHEN mv."earlyAccessPermanent" THEN NULL ELSE mv."earlyAccessEndsAt" END,
    jsonb_strip_nulls(jsonb_build_object(
        'download',   CASE WHEN (mv."earlyAccessConfig" ->> 'chargeForDownload')::boolean
                            AND (mv."earlyAccessConfig" ->> 'downloadPrice') IS NOT NULL
                           THEN jsonb_build_object('price', (mv."earlyAccessConfig" ->> 'downloadPrice')::int) END,
        -- generation grant: free wins, else the paid generation-only tier, else bundled (absent)
        'generation', CASE
                        WHEN (mv."earlyAccessConfig" ->> 'freeGeneration')::boolean
                           THEN jsonb_build_object('free', true)
                        WHEN (mv."earlyAccessConfig" ->> 'chargeForGeneration')::boolean
                            AND (mv."earlyAccessConfig" ->> 'generationPrice') IS NOT NULL
                           THEN jsonb_strip_nulls(jsonb_build_object(
                                  'price',      (mv."earlyAccessConfig" ->> 'generationPrice')::int,
                                  'trialLimit', (mv."earlyAccessConfig" ->> 'generationTrialLimit')::int))
                        ELSE NULL
                      END
    )),
    NOW()
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE mv."availability" = 'EarlyAccess'
  AND (mv."earlyAccessEndsAt" > NOW() OR mv."earlyAccessPermanent" = true)
ON CONFLICT ("entityType", "entityId") DO NOTHING;

-- Post-backfill validation to run manually before cutover (report, do NOT silently clamp money):
--   rows with empty terms:            SELECT * FROM "PaidAccess" WHERE terms = '{}'::jsonb;
--   download below floor / < gen:     SELECT * FROM "PaidAccess"
--       WHERE (terms->'download'->>'price')::int < 100
--          OR (terms->'generation'->>'price')::int < 50
--          OR (terms->'download'->>'price')::int < (terms->'generation'->>'price')::int;

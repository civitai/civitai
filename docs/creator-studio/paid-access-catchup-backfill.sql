-- ============================================================================
-- PaidAccess / DonationGoal CATCH-UP BACKFILL  (safe to re-run)
-- ============================================================================
-- Purpose: pick up model versions gated with early access, and donation goals,
-- that were CREATED by old code during the coexistence window (after the initial
-- backfill ran, before the new code goes live). Run this at cutover, just before
-- the new app code takes over — after that, the new code writes PaidAccess
-- natively and no further backfill is needed.
--
-- This file contains ONLY the idempotent backfill statements — NO DDL. The
-- migrations (early_access_permanent, add_initial_published_at, create_paid_access,
-- paid_access_create_omissions, donation_goal_entity) must ALREADY be applied;
-- re-running their ADD COLUMN / CREATE TABLE / CREATE INDEX / CREATE TYPE would
-- error "already exists". These statements will not.
--
-- Semantics: INSERT-only / fill-NULL-only, NOT an upsert. It catches NEW gates and
-- goals; it does NOT update a row whose terms CHANGED, nor delete a PaidAccess row
-- for a gate that was REMOVED, between runs. Those need the new-code path or a
-- manual fix.
--
-- Run inside the transaction below so that if a malformed earlyAccessConfig makes a
-- ::int/::boolean cast throw, the whole thing rolls back cleanly (find + fix the bad
-- row, then re-run) instead of leaving a partial backfill.
-- ============================================================================

BEGIN;

-- 1) PaidAccess rows for CURRENTLY-GATED model versions. ON CONFLICT DO NOTHING =
--    inserts new gates, skips ones already backfilled. Permanent -> endsAt NULL.
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

-- 2) timeframeDays for the rows just inserted. MUST run after (1): the INSERT above
--    does not populate timeframeDays, so new rows land with it NULL. Timed gates
--    only; permanent (endsAt NULL) stays NULL. Regex guard keeps the ::int cast safe.
UPDATE "PaidAccess" pa
SET "timeframeDays" = (mv."earlyAccessConfig" ->> 'timeframe')::int
FROM "ModelVersion" mv
WHERE pa."entityType" = 'ModelVersion'
  AND pa."entityId" = mv.id
  AND pa."timeframeDays" IS NULL
  AND pa."endsAt" IS NOT NULL
  AND (mv."earlyAccessConfig" ->> 'timeframe') ~ '^[0-9]+$';

-- 3) DonationGoal entityType/entityId from the FK. Mostly a safety net: the
--    donation_goal_fill_entity trigger already fills these on new/updated goals.
UPDATE "DonationGoal"
SET "entityType" = 'ModelVersion', "entityId" = "modelVersionId"
WHERE "modelVersionId" IS NOT NULL AND "entityId" IS NULL;

COMMIT;

-- ============================================================================
-- Post-backfill validation (READ-ONLY) — run AFTER commit and eyeball before
-- flipping to the new code. Report, do NOT silently clamp money.
-- ============================================================================

-- Gated rows that charge nothing (empty terms) — decide policy before cutover:
SELECT * FROM "PaidAccess" WHERE terms = '{}'::jsonb;

-- Prices below floor, or a generation price above the download price:
SELECT * FROM "PaidAccess"
WHERE (terms->'download'->>'price')::int < 100
   OR (terms->'generation'->>'price')::int < 50
   OR (terms->'download'->>'price')::int < (terms->'generation'->>'price')::int;

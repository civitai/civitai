-- Sync the Buzz membership catalog's plan-card badge IMAGE with its cash tier.
--
-- Context: docs/features/buzz-memberships.md
--
-- The three `buzzPurchase` products hold the `badge` image copied when they were seeded,
-- so their plan cards show a stale month's badge. This copies `badge` and `badgeType` from
-- the matching cash product (civitai-bronze / -silver / -gold). In prod (replica,
-- 2026-10-22) badgeType already matches, so in practice only the image changes. Nothing
-- else is touched: monthlyBuzz stays absent or 0, the multipliers stay 1.
--
-- Optional: once the app change ships, the 01:00 UTC syncActiveBadgeMetadata run makes the
-- same update on its own. This only makes it happen sooner.
--
-- This only changes what the plan card shows. Badge DELIVERY does not read these keys.
--
-- Idempotent: a second run updates 0 rows.
--
-- HOW TO RUN (psql). Dry run by default, it rolls back:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/oneoffs/buzz-membership-products-badge.sql
-- Apply:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v apply=1 -f scripts/oneoffs/buzz-membership-products-badge.sql
-- Any value commits (`-v apply=0` too): psql only checks that `apply` is set.

BEGIN;

-- Before.
SELECT
  id,
  metadata ->> 'tier' AS tier,
  metadata ->> 'badgeType' AS badge_type,
  metadata ->> 'badge' AS badge,
  metadata ->> 'monthlyBuzz' AS monthly_buzz,
  metadata ->> 'purchasesMultiplier' AS purchases_multiplier,
  metadata ->> 'rewardsMultiplier' AS rewards_multiplier
FROM "Product"
WHERE (metadata ->> 'buzzPurchase')::boolean IS TRUE
ORDER BY id;

DO $$
DECLARE
  found int;
BEGIN
  SELECT count(*) INTO found FROM "Product" WHERE (metadata ->> 'buzzPurchase')::boolean IS TRUE;
  IF found <> 3 THEN
    RAISE EXCEPTION 'Expected 3 buzzPurchase products, found %. Aborting.', found;
  END IF;
END $$;

WITH updated AS (
  UPDATE "Product" b
  SET metadata = b.metadata || jsonb_build_object(
    'badge', c.metadata -> 'badge',
    'badgeType', c.metadata -> 'badgeType'
  )
  FROM "Product" c
  WHERE (b.metadata ->> 'buzzPurchase')::boolean IS TRUE
    AND c.id = 'civitai-' || (b.metadata ->> 'tier')
    AND c.metadata ? 'badge'
    AND c.metadata ? 'badgeType'
    AND (
      b.metadata -> 'badge' IS DISTINCT FROM c.metadata -> 'badge'
      OR b.metadata -> 'badgeType' IS DISTINCT FROM c.metadata -> 'badgeType'
    )
  RETURNING b.id
)
SELECT count(*) AS products_updated FROM updated;

-- After.
SELECT
  id,
  metadata ->> 'tier' AS tier,
  metadata ->> 'badgeType' AS badge_type,
  metadata ->> 'badge' AS badge,
  metadata ->> 'monthlyBuzz' AS monthly_buzz,
  metadata ->> 'purchasesMultiplier' AS purchases_multiplier,
  metadata ->> 'rewardsMultiplier' AS rewards_multiplier
FROM "Product"
WHERE (metadata ->> 'buzzPurchase')::boolean IS TRUE
ORDER BY id;

-- Fail (and roll back) unless every Buzz product now shows a badge, keeps its level, and
-- still withholds monthly Buzz (key absent or 0) and the bonus multipliers.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(id, ', ') INTO bad
  FROM "Product"
  WHERE (metadata ->> 'buzzPurchase')::boolean IS TRUE
    AND (
      COALESCE(metadata ->> 'badgeType', 'none') = 'none'
      -- Without a level the delivery's level join maps them to no badge, silently.
      OR NOT (metadata ? 'level')
      OR COALESCE((metadata ->> 'monthlyBuzz')::numeric, 0) <> 0
      OR COALESCE((metadata ->> 'purchasesMultiplier')::numeric, 1) <> 1
      OR COALESCE((metadata ->> 'rewardsMultiplier')::numeric, 1) <> 1
    );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Buzz products not in the expected state: %. Aborting.', bad;
  END IF;
END $$;

\if :{?apply}
COMMIT;
\else
ROLLBACK;
\echo 'Dry run: rolled back. Re-run with -v apply=1 to commit.'
\endif

-- COUNTS for the at-ship grant (read-only, run on the replica). The badge itself is
-- delivered by the 01:00 UTC unlock-prepaid-tokens cron (deliverMonthlyCosmetics), not by
-- this script. Run once before the deploy and once after the first 01:00 UTC.
--
-- 1. Active Buzz members, by tier:
--
--   SELECT p.metadata ->> 'tier' AS tier, count(DISTINCT cs."userId") AS members
--   FROM "CustomerSubscription" cs
--   JOIN "Product" p ON p.id = cs."productId"
--   WHERE (p.metadata ->> 'buzzPurchase')::boolean IS TRUE
--     AND cs.status = 'active'
--     AND cs."currentPeriodEnd" > now()
--   GROUP BY 1 ORDER BY 1;
--
-- 2. Of those, how many hold this month's badge for their own tier:
--
--   SELECT p.metadata ->> 'tier' AS tier, count(DISTINCT cs."userId") AS holders
--   FROM "CustomerSubscription" cs
--   JOIN "Product" p ON p.id = cs."productId"
--   JOIN "Cosmetic" c ON c."productId" = 'civitai-' || (p.metadata ->> 'tier')
--     AND c."availableStart" IS NOT NULL
--     AND c."availableStart"::date <= now()::date
--     AND (c."availableEnd" IS NULL OR c."availableEnd"::date >= now()::date)
--   JOIN "UserCosmetic" uc ON uc."userId" = cs."userId" AND uc."cosmeticId" = c.id
--   WHERE (p.metadata ->> 'buzzPurchase')::boolean IS TRUE
--     AND cs.status = 'active'
--     AND cs."currentPeriodEnd" > now()
--   GROUP BY 1 ORDER BY 1;
--
-- Expected after the first 01:00 UTC run: holders = members for each tier, less anyone
-- whose period ends that day (deliverMonthlyCosmetics skips the expiry day on purpose).

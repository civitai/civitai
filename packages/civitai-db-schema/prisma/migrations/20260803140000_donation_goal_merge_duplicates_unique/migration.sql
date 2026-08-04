-- One goal per entity has always been the intent (ensureDonationGoal's create-once guard), but
-- nothing enforced it: findFirst-then-create runs outside a transaction with no unique index, so
-- concurrent early-access writes all pass the guard and insert. 15 entities accumulated 2-5
-- identical goals. Because donationGoalByEntity reads with an unordered findFirst and sums only
-- that row's donations, their totals were split and under-reported (e.g. version 1284890 showed
-- 30,050 of a 50,000 goal while actually holding 54,530 across two rows).
--
-- Donation.donationGoalId is ON DELETE CASCADE, so the losing rows must NOT be deleted first --
-- that would take their donations with them. Repoint, then delete.
--
-- Applied manually (we do NOT use prisma migrate deploy).
--
-- DEPLOY ORDER: apply BEFORE the code deploys. ensureDonationGoal's INSERT ... ON CONFLICT infers
-- the index below from its predicate; without it Postgres rejects the statement outright ("no
-- unique or exclusion constraint matching the ON CONFLICT specification") and every early-access
-- write fails. The old read-then-create still works fine against this migration, so applying it
-- early is safe.

BEGIN;

-- Winner per (entityType, entityId): most donated buzz, then oldest, then lowest id. Keeping the
-- row that already displays the largest progress makes the merge the least visible to donors.
-- `active` is deliberately NOT in the ordering: entity 1418446's only active row is the empty
-- phantom from the race, and preferring it would move real donations onto a resurrected goal
-- instead of dropping the phantom.
CREATE TEMP TABLE donation_goal_merge ON COMMIT DROP AS
WITH totals AS (
  SELECT "donationGoalId" AS goal_id, sum(amount) AS buzz
  FROM "Donation"
  GROUP BY 1
),
ranked AS (
  SELECT
    dg.id,
    dg."entityType",
    dg."entityId",
    row_number() OVER (
      PARTITION BY dg."entityType", dg."entityId"
      ORDER BY COALESCE(t.buzz, 0) DESC, dg."createdAt", dg.id
    ) AS rn
  FROM "DonationGoal" dg
  LEFT JOIN totals t ON t.goal_id = dg.id
  WHERE dg."entityType" IS NOT NULL
    AND dg."entityId" IS NOT NULL
)
SELECT loser.id AS loser_id, winner.id AS winner_id
FROM ranked loser
JOIN ranked winner
  ON winner."entityType" = loser."entityType"
 AND winner."entityId" = loser."entityId"
 AND winner.rn = 1
WHERE loser.rn > 1;

UPDATE "Donation" d
SET "donationGoalId" = m.winner_id
FROM donation_goal_merge m
WHERE d."donationGoalId" = m.loser_id;

DELETE FROM "DonationGoal"
WHERE id IN (SELECT loser_id FROM donation_goal_merge);

-- Partial so the 482 legacy rows with no entity key stay out of the index entirely. They would not
-- collide anyway (a unique index treats NULLs as distinct), so the predicate is about scope, not
-- correctness: the constraint is a statement about entity-keyed goals only.
CREATE UNIQUE INDEX IF NOT EXISTS "DonationGoal_entityType_entityId_key"
ON "DonationGoal" ("entityType", "entityId")
WHERE "entityType" IS NOT NULL AND "entityId" IS NOT NULL;

COMMIT;

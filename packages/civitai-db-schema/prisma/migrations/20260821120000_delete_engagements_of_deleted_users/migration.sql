-- Backfill for the `deleteUser` predicate fix (868kurkcf).
--
-- `deleteUser` meant to clear a deleted account's UserEngagement rows but its
-- predicate was `OR: [{ userId, targetUserId }]` — one OR element carrying two
-- fields, i.e. `userId = X AND targetUserId = X`, which matches only a
-- self-engagement row. `deleteUser` soft-deletes the User row, so no FK cascade
-- covered for it: every follow, hide and block belonging to or aimed at a deleted
-- account is still there, and `getUserList` still counts them. That is the
-- "deleted people in my followers list" complaint.
--
-- APPLY BY HAND, off-peak. This repo does not run `prisma migrate deploy`.
--
-- Measured on the prod replica 2026-08-21: 42,187,643 rows total, of which
-- 3,080,712 (7.3%) reference one of 1,317,709 soft-deleted users — 771,882 by a
-- deleted user, 2,367,030 aimed at one, 58,201 both. EXPLAIN ANALYZE of the work
-- list below: one Seq Scan, two hashed subplans off `User_deletedAt_notnull_idx`,
-- 16.1 s.
--
-- 🔴 Run it with autocommit on (plain psql, no surrounding BEGIN). The DO block
-- COMMITs per batch, which PostgreSQL refuses inside an explicit transaction.
--
-- ONE scan, then a PK-driven drain. `UserEngagement`'s only indexes are the PK
-- (userId, targetUserId) and (type, userId) — nothing on targetUserId alone — so
-- matching rows costs a sequential scan whichever direction you come from. Doing
-- that scan once into a work list is what keeps this linear: a loop that re-finds
-- its next batch in the live table restarts from the beginning every iteration,
-- over the dead tuples it just made, and degrades quadratically.
--
-- Keyed by primary key, not `ctid` — VACUUM can hand a ctid to a different row.

CREATE TEMP TABLE doomed_engagement AS
SELECT e."userId", e."targetUserId"
FROM "UserEngagement" e
WHERE EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."userId" AND u."deletedAt" IS NOT NULL)
   OR EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."targetUserId" AND u."deletedAt" IS NOT NULL);

CREATE INDEX ON doomed_engagement ("userId", "targetUserId");

DO $$
DECLARE
  picked integer;
  done integer := 0;
BEGIN
  LOOP
    -- `picked` counts the WORK LIST batch, not the UserEngagement delete: a row
    -- can already be gone (a re-run, or `deleteUser` reaching it first), and
    -- exiting on that count would stop with the list still full.
    WITH batch AS (
      DELETE FROM doomed_engagement d
      WHERE (d."userId", d."targetUserId") IN (
        SELECT "userId", "targetUserId" FROM doomed_engagement LIMIT 10000
      )
      RETURNING d."userId", d."targetUserId"
    ), gone AS (
      DELETE FROM "UserEngagement" ue
      USING batch b
      WHERE ue."userId" = b."userId" AND ue."targetUserId" = b."targetUserId"
      RETURNING 1
    )
    SELECT count(*) INTO picked FROM batch;
    EXIT WHEN picked = 0;
    done := done + picked;
    RAISE NOTICE 'drained % of the work list', done;
    COMMIT;
  END LOOP;
END $$;

DROP TABLE IF EXISTS doomed_engagement;

-- Confirm from the database's own state, not from an exit code. This must return
-- 0; it is the same predicate the work list was built from.
SELECT count(*) AS engagements_still_referencing_a_deleted_user
FROM "UserEngagement" e
WHERE EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."userId" AND u."deletedAt" IS NOT NULL)
   OR EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."targetUserId" AND u."deletedAt" IS NOT NULL);

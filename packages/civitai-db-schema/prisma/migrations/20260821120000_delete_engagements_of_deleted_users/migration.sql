-- Backfill for the `deleteUser` predicate fix (868kurkcf).
--
-- `deleteUser` meant to clear a deleted account's UserEngagement rows but its
-- predicate was `OR: [{ userId, targetUserId }]` — one OR element carrying two
-- fields, i.e. `userId = X AND targetUserId = X`, which matches only a
-- self-engagement row. `deleteUser` soft-deletes the User row, so no FK cascade
-- covered for it: every follow and hide belonging to or aimed at a deleted account
-- is still there, and `getUserList` still counts them. That is the "deleted people
-- in my followers list" complaint.
--
-- 🔴 BLOCKS ARE EXEMPT, matching the service. Account deletion is reversible
-- (`restoreUser`), and nothing restores engagements, so clearing a Block would
-- silently switch off a safety control its owner set and never tell them. A Follow
-- or a Hide is list noise; a Block is not.
--
-- APPLY BY HAND, off-peak. This repo does not run `prisma migrate deploy`.
--
-- HOW TO RUN IT
--   psql "<conn>" -f migration.sql          -- one session, autocommit, DIRECT connection
-- 🔴 Not `psql -1`, not a multi-statement `psql -c`, not a GUI runner that opens its
--   own transaction: the DO block COMMITs per batch and PostgreSQL raises
--   `invalid transaction termination` inside an explicit transaction.
-- 🔴 Not through a transaction-pooled connection: the temp table has to outlive each
--   batch COMMIT in the same session.
-- Re-runnable end to end. A run that dies part-way leaves the committed batches
-- deleted and the temp table gone with the session; starting again rebuilds the work
-- list from whatever is left.
--
-- MEASURED on the prod replica, 2026-08-21 (PG 18.3): 42,187,643 rows total;
-- 3,080,712 (7.3%) reference one of 1,317,709 soft-deleted users — 771,882 by a
-- deleted user, 2,367,030 aimed at one, 58,201 both. Excluding Blocks, this script
-- clears 3,038,591 of them and leaves 42,121 Blocks standing: 304 batches of 10,000.
-- EXPLAIN ANALYZE of the work-list build: one Seq Scan, two hashed subplans off
-- `User_deletedAt_notnull_idx`, 16.1 s.
--
-- REHEARSED on dev 2026-08-21, scoped to 200 deleted users: work list 711 rows,
-- drained in 4 batches of 200 with the keyset cursor advancing each time, the temp
-- table surviving every COMMIT, the loop exiting on its own, and the post-check
-- going 711 -> 0.
--
-- ONE scan, then a keyset drain. Doing that scan once is what keeps this linear: a
-- loop that re-finds its next batch in the live table restarts from block 0 every
-- iteration, over the dead tuples the previous ones made. Measured on the shape this
-- replaced — 2.91 s and 1.84M buffer touches to find the FIRST 10,000 rows, ~78
-- batches, on the order of 1.4 billion buffer touches and a full `shared_buffers`
-- eviction for everything else on the box.
--
-- The drain walks the work list by KEY rather than deleting from it, so each batch is
-- an index range read instead of a fresh scan over its accumulating dead tuples
-- (autovacuum never touches a temp table).
--
-- Keyed by primary key, not `ctid` — VACUUM can hand a ctid to a different row.

DROP TABLE IF EXISTS doomed_engagement;

CREATE TEMP TABLE doomed_engagement AS
SELECT e."userId", e."targetUserId"
FROM "UserEngagement" e
WHERE e.type <> 'Block'
  AND (EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."userId" AND u."deletedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."targetUserId" AND u."deletedAt" IS NOT NULL));

CREATE INDEX ON doomed_engagement ("userId", "targetUserId");
ANALYZE doomed_engagement;

DO $$
DECLARE
  cursor_key integer[] := ARRAY[-2147483648, -2147483648];
  batch_max integer[];
  picked integer;
  done bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT d."userId", d."targetUserId"
      FROM doomed_engagement d
      WHERE ARRAY[d."userId", d."targetUserId"] > cursor_key
      ORDER BY d."userId", d."targetUserId"
      LIMIT 10000
    ), gone AS (
      DELETE FROM "UserEngagement" ue
      USING batch b
      WHERE ue."userId" = b."userId"
        AND ue."targetUserId" = b."targetUserId"
        AND ue.type <> 'Block'
      RETURNING 1
    )
    -- Count the WORK LIST batch, not the UserEngagement delete: a row can already be
    -- gone (a re-run, or `deleteUser` reaching it first), and exiting on that count
    -- would stop with the list still full. `max` over an int[] compares
    -- lexicographically, which is exactly the keyset order above.
    SELECT count(*), max(ARRAY[b."userId", b."targetUserId"]) INTO picked, batch_max FROM batch b;
    EXIT WHEN picked = 0;
    cursor_key := batch_max;
    done := done + picked;
    RAISE NOTICE 'drained % of the work list', done;
    COMMIT;
  END LOOP;
END $$;

DROP TABLE doomed_engagement;

-- ~3M deletions from a 9.6 GB table leaves bloat and stale statistics behind.
VACUUM (ANALYZE) "UserEngagement";

-- Confirm from the database's own state, not from an exit code: `postgres-query` has
-- reported an error having already applied the statement. This must return 0; it is
-- the same predicate the work list was built from.
SELECT count(*) AS non_block_engagements_still_referencing_a_deleted_user
FROM "UserEngagement" e
WHERE e.type <> 'Block'
  AND (EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."userId" AND u."deletedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."targetUserId" AND u."deletedAt" IS NOT NULL));

-- The app's own follow / hidden / blocked caches are NOT invalidated by this script.
-- Verify from SQL above, not from the site: a stale entry can keep showing a deleted
-- account in a list for up to the cache's TTL (userFollowsCache is one day).

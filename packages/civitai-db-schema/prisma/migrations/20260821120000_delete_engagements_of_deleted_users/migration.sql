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
-- 🔴 HOW TO RUN IT — THIS FILE IS NOT `psql -f`-able AS ONE PASS.
--
-- Step 3 is ONE batch and must be re-run (~304 times) until it reports `drained = 0`.
-- Steps 4 and 5 must not run until then. Feeding the whole file to `psql -f` deletes
-- 10,000 rows, prints a non-zero `after_count`, drops the work list and vacuums a
-- table it barely touched. Nothing is destroyed; you just have not finished.
--
-- Either drive it from a client that loops step 3, or by hand in ONE psql session:
--
--   \i steps 1-2, then repeat step 3 until it prints 0, then steps 4-5.
--
-- Steps 2-5 must share a SESSION — the work list is a temp table.
--
-- 🔴 THE DRAIN LOOP IS DRIVEN BY THE CLIENT, NOT BY A `DO` BLOCK.
--
-- That is not a style choice. The first version wrapped the loop in `DO $$ ... $$`
-- with a per-batch COMMIT, and against prod it died at 920,001 of 3,038,591 rows
-- with `FATAL: query timeout` / `connection to server was lost`. A whole DO block is
-- ONE query to the server, and its internal COMMITs do not reset the query clock —
-- `statement_timeout` is 0 on this database, so the limit is enforced in front of it
-- and no amount of internal batching escapes it. One statement per batch does.
--
-- It also removes two constraints the DO-block version had: no autocommit
-- requirement, and no transaction-pooler restriction, because each statement now
-- commits on its own. The one thing that still matters is that steps 2-4 run in the
-- SAME SESSION, because the work list is a temp table.
--
-- Re-runnable end to end. A run that dies part-way leaves its committed batches
-- deleted; starting again rebuilds the work list from what is left (~16 s) and
-- carries on. Demonstrated for real by the failure above.
--
-- MEASURED on prod, 2026-08-21 (PG 18.3): 42,187,643 rows total; 3,080,712 (7.3%)
-- reference one of 1,317,709 soft-deleted users. Excluding Blocks this clears
-- 3,038,591 and leaves 42,121 Blocks standing: 304 batches of 10,000. EXPLAIN
-- ANALYZE of the work-list build: one Seq Scan, two hashed subplans off
-- `User_deletedAt_notnull_idx`, 16.1 s.
--
-- ONE scan, then a keyset drain. Doing that scan once is what keeps this linear: a
-- loop that re-finds its next batch in the live table restarts from block 0 every
-- iteration, over the dead tuples the previous ones made. Measured on the shape this
-- replaced — 2.91 s and 1.84M buffer touches to find the FIRST 10,000 rows.
--
-- The drain walks the work list by KEY rather than deleting from it, so each batch is
-- an index range read instead of a fresh scan over its accumulating dead tuples
-- (autovacuum never touches a temp table). Keyed by primary key, not `ctid` — VACUUM
-- can hand a ctid to a different row.

-- ── Step 1: the count BEFORE. Expect ~3,038,591. A 0 at the end proves nothing
-- unless this was non-zero first.
SELECT count(*) AS before_count
FROM "UserEngagement" e
WHERE e.type <> 'Block'
  AND (EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."userId" AND u."deletedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."targetUserId" AND u."deletedAt" IS NOT NULL));

-- ── Step 2: build the work list. One sequential scan, ~16 s.
DROP TABLE IF EXISTS doomed_engagement;

CREATE TEMP TABLE doomed_engagement AS
SELECT e."userId", e."targetUserId", false AS done
FROM "UserEngagement" e
WHERE e.type <> 'Block'
  AND (EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."userId" AND u."deletedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."targetUserId" AND u."deletedAt" IS NOT NULL));

CREATE INDEX ON doomed_engagement (done, "userId", "targetUserId");
ANALYZE doomed_engagement;

-- ── Step 3: ONE batch. Re-run until `drained` is 0. ~304 times.
--
-- `done` is flipped rather than the row deleted, so the work table keeps no dead
-- tuples to re-scan, and the index on `(done, "userId", "targetUserId")` makes each
-- batch an index range read. Counting the WORK LIST rather than the UserEngagement
-- delete is
-- deliberate: a row can already be gone (a re-run, or `deleteUser` reaching it
-- first), and exiting on that count would stop with the list still full.
WITH batch AS (
  SELECT d."userId", d."targetUserId"
  FROM doomed_engagement d
  WHERE d.done = false
  ORDER BY d."userId", d."targetUserId"
  LIMIT 10000
), marked AS (
  UPDATE doomed_engagement d
  SET done = true
  FROM batch b
  WHERE d."userId" = b."userId" AND d."targetUserId" = b."targetUserId"
  RETURNING d."userId", d."targetUserId"
), gone AS (
  DELETE FROM "UserEngagement" ue
  USING marked m
  WHERE ue."userId" = m."userId"
    AND ue."targetUserId" = m."targetUserId"
    AND ue.type <> 'Block'
  RETURNING 1
)
SELECT count(*) AS drained FROM marked;

-- ── Step 4: the count AFTER. MUST be 0. Same predicate step 1 used.
SELECT count(*) AS after_count
FROM "UserEngagement" e
WHERE e.type <> 'Block'
  AND (EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."userId" AND u."deletedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."targetUserId" AND u."deletedAt" IS NOT NULL));

DROP TABLE doomed_engagement;

-- ── Step 5: ~3M deletions from a 9.6 GB table leaves bloat and stale statistics.
VACUUM (ANALYZE) "UserEngagement";

-- Verify from the SQL above, never from the site: this invalidates none of the app's
-- caches, so a stale `userFollowsCache` entry can keep showing a deleted account in a
-- followers list for up to its TTL (one day).

-- Make (fromModelId, toModelId, type) unique on "ModelAssociations".
--
-- Migrations in this repo are applied BY HAND. Read this header first.
--
--
-- ORDER RELATIVE TO DEPLOYS
--
-- Apply this BEFORE deploying any code that inserts into "ModelAssociations" with
-- ON CONFLICT DO NOTHING. That clause is valid with no unique index, but it then conflicts
-- with nothing and silently stops deduplicating. Rows minted in that window are found only
-- at the END of the index build below, which then fails having paid for the whole thing.
--
--
-- WHAT IS LIVE IN THIS FILE
--
-- Five statements, numbered 1 to 5. One is destructive (1, the DELETE) and one is expensive
-- (4, the index build); 2, 3 and 5 are read-only checks.
--
-- The recovery DROP is deliberately NOT a live statement. It is commented out under RETRY
-- below, and it is the only thing here that can destroy working state. Running this file whole
-- must never be able to drop an index that is fine — so the drop is something you paste
-- deliberately, after reading check 2, and never something the file does on your behalf.
--
-- Statement 4 CANNOT run inside a transaction block, and neither can the commented DROP when
-- you paste it. Everything else may. Note that `psql -c "a; b"` wraps its argument in an
-- implicit transaction, so do not batch statement 4 with anything.
--
-- Do NOT run statement 4 in a session with lock_timeout set. CREATE INDEX CONCURRENTLY takes
-- a brief lock at each end of the build, and a timeout there fails DIRTY, leaving an INVALID
-- index behind. `SET lock_timeout = 0` for the session.
--
--
-- FIRST RUN — 1, 2, 3, 4, 5 in order.
--   Check 2 returns no rows, which is what you expect: the index does not exist yet.
--   Check 3 must return zero rows before you run 4. If it does not, statement 4 will fail at
--   the end of a full build.
--   Check 5 must return exactly one row reading true.
--
-- IF STATEMENT 4 FAILED, OR WAS INTERRUPTED — an interrupted, cancelled or lock-timed-out
-- build leaves an index under the target name that is INVALID: it enforces nothing, no query
-- uses it, every write maintains it, and Postgres does not remove it for you. So does a build
-- that ran to completion and then found a duplicate. Retry as:
--   run 2. If it returns no rows, just run 3, 4, 5 again.
--   If it returns false, the broken index is there: paste the DROP from RETRY below, then run
--   1 and 3 again — a duplicate minted since is the other way this fails, and re-running 4
--   without re-checking buys a second full build and the same failure — then 4 and 5.
--   If it returns true, the index is built and correct. Stop. Do not drop anything.
--
-- RE-RUNNING THE WHOLE FILE after a successful apply is safe: 1 deletes nothing, 2 and 5
-- report true, 3 returns nothing, and 4 fails loudly with "relation already exists" because it
-- carries no IF NOT EXISTS. That absence is deliberate — Postgres matches IF NOT EXISTS on the
-- index NAME and not on its validity, so with it a retry over an INVALID index would report
-- success while duplicate suppression stayed off and everything downstream believed it was on.
--
--
-- Model-to-article rows are unaffected: their "toModelId" is NULL, and Postgres treats NULLs as
-- distinct in a unique index.
--
-- Measured on the production replica, 2026-09-11: 571,218 rows; 5 duplicate groups, each of two
-- rows; and none of the four existing indexes (the primary key plus one per @@index) is this
-- one. The dedupe self-join plans at ~255 ms with parallel workers and ~1 s serial, which is
-- what a DELETE gets. The build is a ~20 MB btree over a ~47 MB heap at SHARE UPDATE EXCLUSIVE,
-- which blocks neither reads nor writes.


-- 1. Remove existing duplicates, keeping the lowest id of each group. Expected to report 5 as
-- of 2026-09-11 — a point-in-time observation, not a gate. If it differs, the difference is
-- duplicates created since. What decides whether you may proceed is check 3 returning nothing.
DELETE FROM "ModelAssociations" a
USING "ModelAssociations" b
WHERE a."toModelId" IS NOT NULL
  AND a."fromModelId" = b."fromModelId"
  AND a."toModelId" = b."toModelId"
  AND a."type" = b."type"
  AND a."id" > b."id";


-- 2. Does the index exist, and is it usable? Read this before pasting any DROP.
--   no rows -> it does not exist. Carry on.
--   false   -> a previous build left it broken. See RETRY in the header.
--   true    -> it is built and correct. You are done.
SELECT indisvalid
FROM pg_index
WHERE indexrelid = to_regclass('"ModelAssociations_fromModelId_toModelId_type_key"');


-- 3. Must return zero rows before statement 4. Anything here fails the build at its end.
SELECT "fromModelId", "toModelId", "type", count(*)
FROM "ModelAssociations"
WHERE "toModelId" IS NOT NULL
GROUP BY 1, 2, 3
HAVING count(*) > 1;


-- 4. The index. Cannot run inside a transaction block; see the header on lock_timeout and on
-- the deliberate absence of IF NOT EXISTS. The name is the one Prisma derives from
-- @@unique([fromModelId, toModelId, type]), so the follow-up declaring it introspects clean.
CREATE UNIQUE INDEX CONCURRENTLY "ModelAssociations_fromModelId_toModelId_type_key"
  ON "ModelAssociations" ("fromModelId", "toModelId", "type");


-- 5. Must return exactly one row reading true. False means the build did not finish: go to
-- RETRY in the header.
SELECT indisvalid
FROM pg_index
WHERE indexrelid = to_regclass('"ModelAssociations_fromModelId_toModelId_type_key"');


-- RETRY — paste this ONLY when check 2 returned false. It cannot run inside a transaction
-- block either. Against a valid index it destroys a working constraint and leaves the table
-- unprotected for the length of a fresh build, which is why it is not a live statement:
--
--   DROP INDEX CONCURRENTLY "ModelAssociations_fromModelId_toModelId_type_key";

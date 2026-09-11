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
-- Six numbered steps. Step 1 issues two SET commands, so seven statements in all. One step is
-- destructive (2, the DELETE), one is expensive (5, the index build), and 3, 4 and 6 are
-- read-only checks.
--
-- The recovery DROP is deliberately NOT live. It is commented out under RECOVERY at the bottom,
-- and it is the only thing here that can destroy working state. Running this file whole must
-- never be able to drop an index that is fine, so the drop is something you paste deliberately
-- after reading check 3, never something the file does on your behalf.
--
--
-- HOW TO INVOKE IT
--
-- Step 5 CANNOT run inside a transaction block, and neither can the commented DROP when you
-- paste it. Everything else may. Two consequences:
--   * do not batch step 5 with anything — `psql -c "a; b"` wraps its argument in an implicit
--     transaction;
--   * do NOT use `psql -1` / `--single-transaction` on this file. That wraps the whole file in
--     one transaction and step 5 fails with "cannot run inside a transaction block", rolling
--     the DELETE back with it. Plain `psql -f` is fine: without that flag psql runs in
--     autocommit and sends each statement separately.
--
-- Step 1 exists because a session timeout is the one thing that turns a clean run into a broken
-- one: CREATE INDEX CONCURRENTLY waits for locks at each end of the build, and a lock_timeout
-- or statement_timeout firing there fails DIRTY, leaving an INVALID index behind. It is a live
-- statement rather than an instruction because an instruction is something you can skip.
-- SET is session-scoped, so step 1 must run in the SAME session as step 5. If you are pasting
-- steps one at a time into separate sessions, paste step 1 again before step 5.
--
--
-- FIRST RUN — 1, 2, 3, 4, 5, 6 in order.
--   Check 3 returns no rows, which is expected: the index does not exist yet.
--   Check 4 must return zero rows before you run 5, or 5 fails at the end of a full build.
--   Check 6 must return exactly one row reading true. Judge the outcome by check 6, not by
--   whether step 5 printed an error — see RECOVERY for why those are not the same question.
--
-- IF STEP 5 FAILED, OR WAS INTERRUPTED — see RECOVERY at the bottom of this file.
--
-- RE-RUNNING THE WHOLE FILE after a successful apply is safe: step 2 deletes nothing, checks 3
-- and 6 report true, check 4 returns nothing, and step 5 fails with "relation already exists"
-- because it carries no IF NOT EXISTS. That absence is deliberate — Postgres matches IF NOT
-- EXISTS on the index NAME and not on its validity, so with it a retry over an INVALID index
-- would report success while duplicate suppression stayed off and everything downstream
-- believed it was on.
--
--
-- Model-to-article rows are unaffected: their "toModelId" is NULL, and Postgres treats NULLs as
-- distinct in a unique index.
--
-- Measured on the production replica, 2026-09-11: 571,218 rows; 5 duplicate groups, each of two
-- rows; and none of the four existing indexes (the primary key plus one per @@index) is this
-- one. The dedupe self-join plans at ~255 ms with parallel workers and ~1 s serial, which is
-- what a DELETE gets. The build holds SHARE UPDATE EXCLUSIVE for its duration, which blocks
-- neither reads nor writes; the waits that a timeout can interrupt are at each end of it.


-- 1. Session setup. Must be the same session as step 5 — see the header.
SET lock_timeout = 0;
SET statement_timeout = 0;


-- 2. Remove existing duplicates, keeping the lowest id of each group. Expected to report 5 as
-- of 2026-09-11 — a point-in-time observation, not a gate. If it differs, the difference is
-- duplicates created since. What decides whether you may proceed is check 4 returning nothing.
DELETE FROM "ModelAssociations" a
USING "ModelAssociations" b
WHERE a."toModelId" IS NOT NULL
  AND a."fromModelId" = b."fromModelId"
  AND a."toModelId" = b."toModelId"
  AND a."type" = b."type"
  AND a."id" > b."id";


-- 3. Does the index exist, and is it usable? Read this before pasting any DROP.
--   no rows -> it does not exist. Carry on. (If your search_path does not reach the table's
--              schema you also get no rows; step 5 then fails on "already exists".)
--   false   -> a previous build left it broken. See RECOVERY at the bottom.
--   true    -> it is built and correct. You are done.
SELECT indisvalid
FROM pg_index
WHERE indexrelid = to_regclass('"ModelAssociations_fromModelId_toModelId_type_key"');


-- 4. Must return zero rows before step 5. Anything here fails the build at its end.
SELECT "fromModelId", "toModelId", "type", count(*)
FROM "ModelAssociations"
WHERE "toModelId" IS NOT NULL
GROUP BY 1, 2, 3
HAVING count(*) > 1;


-- 5. The index. Cannot run inside a transaction block; needs step 1 in the same session. The
-- name is the one Prisma derives from @@unique([fromModelId, toModelId, type]), so the
-- follow-up declaring it introspects clean.
CREATE UNIQUE INDEX CONCURRENTLY "ModelAssociations_fromModelId_toModelId_type_key"
  ON "ModelAssociations" ("fromModelId", "toModelId", "type");


-- 6. The verdict. Must return exactly one row reading true. False means the build did not
-- finish: see RECOVERY. This is the check that decides, not step 5's output — a build over an
-- INVALID index and a re-run after a successful apply print the same "relation already exists",
-- and psql sends errors to stderr and results to stdout, so under a pipe they interleave.
SELECT indisvalid
FROM pg_index
WHERE indexrelid = to_regclass('"ModelAssociations_fromModelId_toModelId_type_key"');


-- RECOVERY — when check 3 or check 6 returned false.
--
-- An INVALID index enforces nothing, no query uses it, every write maintains it, and Postgres
-- does not remove it for you. Two things leave one: a build interrupted, cancelled or timed
-- out; and a build that ran to completion and then found a duplicate. Both end the same way,
-- so recover the same way and let check 4 tell you which it was.
--
-- Paste this — it cannot run inside a transaction block either. Against a VALID index it
-- destroys a working constraint and leaves the table unprotected for a full rebuild, which is
-- why it is not a live statement. Only paste it when a check returned false.
--
--   DROP INDEX CONCURRENTLY "ModelAssociations_fromModelId_toModelId_type_key";
--
-- Then run steps 2 and 4 again before 5 and 6 — whichever way the build died, a duplicate may
-- have been minted while the invalid index was enforcing nothing, and re-running 5 without
-- re-checking buys a second full build and the same ending.

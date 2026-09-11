-- Make (fromModelId, toModelId, type) unique on "ModelAssociations".
-- Applied by hand, like every migration here.
--
-- Five earlier versions of this header tried to enumerate every way the apply can go wrong.
-- Each one got something wrong, and each wrong thing was introduced while correcting the last.
-- So it now states only what an operator must do and what decides the outcome. If you hit
-- something not described here, the answer is in the Postgres docs for CREATE INDEX
-- CONCURRENTLY, not in a sentence I guessed at.
--
--
-- HOW TO RUN IT
--
-- Open ONE interactive psql session against the primary and run the steps in order. Not
-- through a connection pooler: in transaction mode a pooler can put step 1 and step 5 on
-- different backends, and step 1 is what keeps step 5 from failing dirty.
--
-- Do not use `psql -1` / `--single-transaction`: step 5 cannot run inside a transaction block,
-- and its failure takes the DELETE back with it. `psql -c` per step is also wrong — each is its
-- own session, so step 1's settings are gone by step 5.
--
-- Step 1 disables the two timeouts that abort an index build DIRTY, leaving an index that
-- enforces nothing. Before running it, check `pg_stat_activity` for long transactions touching
-- "ModelAssociations": with no timeout, step 5 waits behind them indefinitely and later lock
-- requests queue behind it. Cancelling step 5 once it is running costs the whole build and puts
-- you in RECOVERY. On PostgreSQL 17+ `transaction_timeout` can also abort it and step 1 does
-- not cover that.
--
--
-- WHAT DECIDES THE OUTCOME
--
-- Check 6, and nothing else. Not step 5's output — a build over a broken index and a re-run
-- after a successful apply print the same "relation already exists".
--   true      you are done.
--   false     an index exists and enforces nothing. RECOVERY, at the bottom.
--   no rows   nothing was created. Re-run step 5.
--
--
-- ORDER RELATIVE TO DEPLOYS
--
-- Apply this BEFORE deploying code that inserts into "ModelAssociations" with ON CONFLICT DO
-- NOTHING. That clause is valid with no unique index but conflicts with nothing, so rows minted
-- in the window are found only at the end of the build, which then fails having paid for it.
--
--
-- Model-to-article rows are unaffected: their "toModelId" is NULL, and Postgres treats NULLs as
-- distinct in a unique index.
--
-- On the production replica, 2026-09-11: 571,218 rows and 5 duplicate groups of two. Other
-- environments will differ, and a different count there means a different database rather than
-- drift. The dedupe plans at ~1 s serial. The build is a ~20 MB btree over a ~47 MB heap holding
-- SHARE UPDATE EXCLUSIVE, which blocks neither reads nor writes.


-- 1. Same session as step 5. See the header before running this.
SET lock_timeout = 0;
SET statement_timeout = 0;


-- 2. Remove duplicates, keeping the lowest id of each group.
DELETE FROM "ModelAssociations" a
USING "ModelAssociations" b
WHERE a."toModelId" IS NOT NULL
  AND a."fromModelId" = b."fromModelId"
  AND a."toModelId" = b."toModelId"
  AND a."type" = b."type"
  AND a."id" > b."id";


-- 3. Does the index already exist? no rows -> carry on. false -> RECOVERY. true -> you are done.
SELECT indisvalid
FROM pg_index
WHERE indexrelid = to_regclass('"ModelAssociations_fromModelId_toModelId_type_key"');


-- 4. Must return zero rows. Anything here fails the build at its end, after paying for it.
SELECT "fromModelId", "toModelId", "type", count(*)
FROM "ModelAssociations"
WHERE "toModelId" IS NOT NULL
GROUP BY 1, 2, 3
HAVING count(*) > 1;


-- 5. Cannot run inside a transaction block. No IF NOT EXISTS on purpose: Postgres matches that
-- on the index NAME and not its validity, so with it a retry over a broken index reports success
-- while duplicate suppression stays off. The name is the one Prisma derives from
-- @@unique([fromModelId, toModelId, type]), so the follow-up declaring it introspects clean.
CREATE UNIQUE INDEX CONCURRENTLY "ModelAssociations_fromModelId_toModelId_type_key"
  ON "ModelAssociations" ("fromModelId", "toModelId", "type");


-- 6. The verdict. See the header.
SELECT indisvalid
FROM pg_index
WHERE indexrelid = to_regclass('"ModelAssociations_fromModelId_toModelId_type_key"');


-- RECOVERY — only when check 3 or check 6 returned FALSE. Not when either returned no rows;
-- that means nothing was created, and the answer there is to run step 5 again.
--
-- An index that enforces nothing is left behind by a build that was interrupted, cancelled or
-- timed out, and equally by one that ran to completion and then found a duplicate. Both end
-- here and both recover the same way.
--
-- Paste this. It cannot run inside a transaction block either, and against a working index it
-- destroys a real constraint and leaves the table unprotected for a full rebuild — which is why
-- it is not a live statement in this file.
--
--   DROP INDEX CONCURRENTLY "ModelAssociations_fromModelId_toModelId_type_key";
--
-- Then run steps 1, 2 and 4 again before 5 and 6. Step 1 because a pasted DROP often means a
-- fresh session; steps 2 and 4 because a duplicate may have been minted while the broken index
-- was enforcing nothing, and skipping them buys a second full build and the same ending.

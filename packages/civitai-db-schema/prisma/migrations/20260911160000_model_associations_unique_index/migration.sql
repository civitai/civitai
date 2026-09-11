-- Make (fromModelId, toModelId, type) unique on "ModelAssociations".
--
-- Migrations in this repo are applied BY HAND. Read this header before running anything.
--
--
-- ORDER RELATIVE TO DEPLOYS
--
-- Apply this BEFORE deploying any code that inserts into "ModelAssociations" with
-- ON CONFLICT DO NOTHING. That clause is valid with no unique index, but it then conflicts
-- with nothing and silently stops deduplicating. Rows minted in that window are found only
-- at the END of the CREATE INDEX build below, which fails after paying for the whole thing.
--
--
-- WHICH STATEMENTS CANNOT SHARE A TRANSACTION
--
-- Statement 1 (DELETE)                    may run inside a transaction.
-- Statement 2 (SELECT probe)              may run inside a transaction.
-- Statement 3 (DROP INDEX CONCURRENTLY)   MUST NOT run inside a transaction block.
-- Statement 5 (CREATE INDEX CONCURRENTLY) MUST NOT run inside a transaction block.
--
-- Two of the five carry that restriction, not one. Send statements 3 and 5 individually.
-- Note that `psql -c "a; b"` wraps its argument in a transaction, so batching 3 and 5 —
-- they look like one "index step" — fails with
--   ERROR: DROP INDEX CONCURRENTLY cannot run inside a transaction block
-- part-way through. `psql -f` on this file whole has the same problem. Run them one at a time.
--
--
-- WHAT YOU WILL SEE
--
-- First run:     statement 2 returns NO ROWS. Skip statement 3 entirely. Run 1, then 5, then 6.
-- Interrupted:   an interrupted or cancelled CREATE INDEX CONCURRENTLY leaves an index behind
--                under the target name that is INVALID — it enforces nothing and the planner
--                never uses it. Postgres does not remove it for you. Statement 2 is how you
--                find out; it returns a row with indisvalid = false.
-- Retry:         run statement 2 FIRST. Only if it returns indisvalid = false do you run
--                statement 3. If it returns indisvalid = true the index is already built and
--                correct — you are done, and running statement 3 would destroy a working index
--                and leave the table unprotected for the length of a fresh rebuild.
--
-- Statement 5 deliberately carries no IF NOT EXISTS: Postgres matches that on the index NAME
-- and not on its validity, so with it a retry over an INVALID index reports success and leaves
-- duplicate suppression switched off while everything downstream believes it is on.
--
--
-- Model-to-article rows are unaffected: their "toModelId" is NULL, and Postgres treats NULLs
-- as distinct in a unique index.
--
-- Measured on the production replica, 2026-09-11: 571,218 rows, 5 duplicate groups, and none of
-- the four existing indexes is the one created here. The dedupe self-join plans at ~255 ms with
-- parallel workers and ~1 s serial, which is what a DELETE gets. The index build is a ~20 MB
-- btree over a ~47 MB heap at SHARE UPDATE EXCLUSIVE, which blocks neither reads nor writes.


-- Statement 1 — remove existing duplicates, keeping the lowest id of each group.
-- Expected to affect 5 rows as of 2026-09-11. That count is a point-in-time observation, not a
-- gate: if it differs, the extra rows are simply duplicates created since. What matters is that
-- statement 4 returns zero afterwards.
DELETE FROM "ModelAssociations" a
USING "ModelAssociations" b
WHERE a."toModelId" IS NOT NULL
  AND a."fromModelId" = b."fromModelId"
  AND a."toModelId" = b."toModelId"
  AND a."type" = b."type"
  AND a."id" > b."id";


-- Statement 2 — THE GATE. Run this before statement 3, every time.
-- No rows      -> the index does not exist. Skip statement 3.
-- indisvalid f -> a previous build was interrupted. Run statement 3, then 5.
-- indisvalid t -> the index is already built and correct. Stop; do not run 3 or 5.
SELECT indisvalid
FROM pg_index
WHERE indexrelid = to_regclass('"ModelAssociations_fromModelId_toModelId_type_key"');


-- Statement 3 — ONLY when statement 2 returned indisvalid = false.
-- Cannot run inside a transaction block. Running this against a VALID index destroys a working
-- constraint and leaves the table unprotected until statement 5 finishes.
DROP INDEX CONCURRENTLY IF EXISTS "ModelAssociations_fromModelId_toModelId_type_key";


-- Statement 4 — confirm statement 1 left nothing behind. Must return zero rows.
-- The index build below fails at the end if this returns anything.
SELECT "fromModelId", "toModelId", "type", count(*)
FROM "ModelAssociations"
WHERE "toModelId" IS NOT NULL
GROUP BY 1, 2, 3
HAVING count(*) > 1;


-- Statement 5 — the index. Cannot run inside a transaction block, and carries no IF NOT EXISTS
-- on purpose (see the header). The name is the one Prisma derives from @@unique, so the
-- follow-up that declares it in schema.full.prisma introspects clean.
CREATE UNIQUE INDEX CONCURRENTLY "ModelAssociations_fromModelId_toModelId_type_key"
  ON "ModelAssociations" ("fromModelId", "toModelId", "type");


-- Statement 6 — confirm the build finished. Must return exactly one row, with indisvalid = true.
-- A row with false means the build did not complete: go back to statement 3.
SELECT indisvalid
FROM pg_index
WHERE indexrelid = to_regclass('"ModelAssociations_fromModelId_toModelId_type_key"');

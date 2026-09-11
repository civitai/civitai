-- Deduplicate, then make (fromModelId, toModelId, type) unique so a back-link written by the
-- "link both ways" save can never double up. Model-to-article rows have a NULL "toModelId" and
-- are therefore unaffected: Postgres treats NULLs as distinct in a unique index.
--
-- APPLY THIS BEFORE DEPLOYING THE CODE THAT USES IT. The reciprocal write inserts with
-- ON CONFLICT DO NOTHING, which is valid syntax with no unique index but conflicts with
-- nothing — so with the code deployed first, duplicate back-links can be minted in the
-- window, and CREATE INDEX CONCURRENTLY validates only at the end of a full build, so one
-- of them fails the index after the whole build has been paid for.
--
-- APPLY THE TWO STATEMENTS SEPARATELY. CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block, so it must not be sent in the same multi-statement batch as the DELETE.
-- Run the DELETE first and confirm it reports 5 rows before creating the index; the index
-- creation fails outright if any duplicate remains.

-- Statement 1 — 5 duplicate rows on production as of 2026-09-11.
DELETE FROM "ModelAssociations" a
USING "ModelAssociations" b
WHERE a."toModelId" IS NOT NULL
  AND a."fromModelId" = b."fromModelId"
  AND a."toModelId" = b."toModelId"
  AND a."type" = b."type"
  AND a."id" > b."id";

-- The 5 is a point-in-time count, not a gate: re-check it rather than treating it as pass/fail.
--
-- Statement 2 — RUN THIS FIRST ON ANY RETRY, AND ONLY ON A RETRY.
-- A cancelled or interrupted CREATE INDEX CONCURRENTLY leaves an INVALID index behind under
-- the same name. It is not dropped for you, it enforces nothing, and the planner never uses
-- it. Note that `IF NOT EXISTS` is deliberately absent from statement 3 for this reason:
-- Postgres matches it on NAME, not on validity, so a bare re-run would report success over
-- the broken index and everything downstream would believe duplicate suppression is live.
DROP INDEX CONCURRENTLY IF EXISTS "ModelAssociations_fromModelId_toModelId_type_key";

-- Statement 3 — the name Prisma derives from @@unique, so the follow-up that declares
-- @@unique in schema.full.prisma introspects clean.
CREATE UNIQUE INDEX CONCURRENTLY "ModelAssociations_fromModelId_toModelId_type_key"
  ON "ModelAssociations" ("fromModelId", "toModelId", "type");

-- Confirm it is usable before trusting it. `indisvalid` false means the build did not finish:
--   SELECT indisvalid FROM pg_index
--    WHERE indexrelid = '"ModelAssociations_fromModelId_toModelId_type_key"'::regclass;

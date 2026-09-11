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
-- Statement 2 — the name Prisma derives from @@unique, so the follow-up that declares
-- @@unique in schema.full.prisma introspects clean. A cancelled or interrupted
-- CREATE INDEX CONCURRENTLY leaves an INVALID index behind that must be dropped before retrying:
--   DROP INDEX CONCURRENTLY IF EXISTS "ModelAssociations_fromModelId_toModelId_type_key";
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ModelAssociations_fromModelId_toModelId_type_key"
  ON "ModelAssociations" ("fromModelId", "toModelId", "type");

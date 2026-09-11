-- Deduplicate, then make (fromModelId, toModelId, type) unique so a back-link written by the
-- "link both ways" save can never double up. Model-to-article rows have a NULL "toModelId" and
-- are therefore unaffected: Postgres treats NULLs as distinct in a unique index.
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

-- Statement 2 — name matches what Prisma derives from @@unique, so a later introspection agrees.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ModelAssociations_fromModelId_toModelId_type_key"
  ON "ModelAssociations" ("fromModelId", "toModelId", "type");

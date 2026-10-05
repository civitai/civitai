-- Whether the orchestrator currently holds this version resident, maintained by
-- sync-generator-loaded-resources. Display and filtering only.
--
-- Run with `psql -f`, not in a transaction: CREATE INDEX CONCURRENTLY cannot run inside a transaction block,
-- and this DB's statement_timeout will kill an index build on a table this size, leaving an INVALID
-- index behind.
SET statement_timeout = 0;

-- A constant default is metadata-only from Postgres 11, so this does not rewrite the table.
ALTER TABLE "ModelVersion" ADD COLUMN "generatorLoaded" BOOLEAN NOT NULL DEFAULT false;

-- Keyed on id and carrying modelId so the sync job reads the loaded set index-only. Prisma cannot
-- express a covering partial index, so schema.full.prisma documents it instead of declaring it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ModelVersion_generatorLoaded_id_modelId_idx"
  ON "ModelVersion" (id) INCLUDE ("modelId")
  WHERE "generatorLoaded";

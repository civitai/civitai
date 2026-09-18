-- Last time the sync job saw this version resident in the orchestrator.
--
-- A timestamp rather than a boolean because the UI claim is "recently loaded". A version near the
-- orchestrator's eviction line would otherwise flip its badge on every poll, and each flip would cost
-- a row write and a Meilisearch update. Here the job only ever stamps what it currently sees, nothing
-- clears it, and a version ages out of "recent" with no write at all.
--
-- Display and filtering only. The generation-time check stays the orchestrator's.
ALTER TABLE "ModelVersion" ADD COLUMN "generatorLoadedAt" TIMESTAMP(3);

-- Partial: the query is always "loaded since <cutoff>", so rows that have never been loaded are dead
-- weight in the index — and on this table they are the large majority. Prisma cannot express a
-- partial index, so `schema.full.prisma` declares the plain form; the name matches either way.
--
-- CONCURRENTLY cannot run inside a transaction — run this statement on its own, not wrapped in
-- BEGIN/COMMIT with the ALTER above.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ModelVersion_generatorLoadedAt_idx"
  ON "ModelVersion" ("generatorLoadedAt")
  WHERE "generatorLoadedAt" IS NOT NULL;

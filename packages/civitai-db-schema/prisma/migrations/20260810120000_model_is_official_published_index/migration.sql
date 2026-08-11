-- getOfficialModelIds() (src/server/services/resource-select.service.ts) filters
-- "Model" on "isOfficial" = true AND status = 'Published' to build the generation
-- resource picker's official-model pin. Without this index that is a parallel seq
-- scan over ~924K rows (~278ms, ~112K buffers) to return ~70. The result is cached
-- for 5 minutes, so the scan runs on cache expiry rather than per request — but it
-- is the origin fetch every picker open queues behind on a cold key.
--
-- Partial on the exact predicate: the flag is mod-curated and sparse, so the index
-- covers ~70 rows instead of the whole table. "type" is carried as a second column
-- because the query selects only ("id", "type"), which makes this an index-only scan.
--
-- CONCURRENTLY cannot run inside a transaction block. Run this statement on its
-- own, not wrapped in BEGIN/COMMIT.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Model_isOfficial_published_idx"
  ON "Model" ("id", "type")
  WHERE "isOfficial" AND status = 'Published'::"ModelStatus";

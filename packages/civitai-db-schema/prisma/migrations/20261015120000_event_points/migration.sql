-- Event points: per-type counts on the daily per-hat snapshot the hourly referee writes.
--
-- Apply order, all before the deploy that ships the event points engine:
--   1. this file (Postgres). Adding NOT NULL columns with a constant default is metadata-only, so it
--      does not rewrite or long-lock the table.
--   2. the ClickHouse objects below.
--   3. the deploy.
-- The referee writes these columns on its first run, so the deploy must not land first.

ALTER TABLE "EventCosmeticScoreDaily"
  ADD COLUMN IF NOT EXISTS "comments"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "stickers"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "remixes"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "modelLikes" INTEGER NOT NULL DEFAULT 0;

-- ClickHouse (apply separately, against the default database):
--
-- The points ledger. One row per first qualifying action (or removal) on content wearing an event
-- cosmetic. Written by awardEventPoints through the shared client's async inserts; read only by the
-- hourly referee. The referee dedupes on read, so a duplicate insert can never double count.
--
-- CREATE TABLE IF NOT EXISTS default.event_point_events
-- (
--     event      LowCardinality(String),
--     time       DateTime64(3, 'UTC'),
--     type       LowCardinality(String),
--     op         Enum8('add' = 1, 'remove' = 2),
--     actorId    Int32,
--     entityType LowCardinality(String),
--     entityId   Int32,
--     ownerId    Int32,
--     cosmeticId Int32,
--     claimKey   String,
--     team       LowCardinality(String),
--     sourceId   String
-- )
-- ENGINE = MergeTree
-- PARTITION BY (event, toYYYYMM(time))
-- ORDER BY (event, toDate(time), ownerId, actorId, type, entityType, entityId)
-- TTL toDateTime(time) + INTERVAL 400 DAY;
--
-- The old scorer's mirror, default.event_cosmetic_placements, is no longer written or read. Drop it
-- once this has shipped: DROP TABLE IF EXISTS default.event_cosmetic_placements;

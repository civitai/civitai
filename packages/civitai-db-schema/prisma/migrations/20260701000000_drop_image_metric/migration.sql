-- Retire the legacy PostgreSQL `ImageMetric` table.
--
-- It has been superseded by the ClickHouse entity-metric pipeline
-- (entityMetricEvents_month -> entityMetricDailyAgg_v2 -> MetricService.fetch('Image', ...)).
-- Its update processor was already disabled, so every row was frozen at
-- creation-time zeros; all app readers now source counts from ClickHouse.
--
-- ORDER MATTERS. Apply top to bottom:
--   a) drop the writer trigger first, or every image insert errors once the
--      table is gone,
--   b) drop the dependent views (+ dead ranking/feature routines), or
--      `DROP TABLE "ImageMetric"` fails with a dependency error,
--   c) remove the table from the Postgres -> ClickHouse Debezium publication,
--      or the drop fails / breaks replication,
--   d) drop the table (its ON DELETE CASCADE FK to "Image" drops with it).
--
-- NOTE: applied MANUALLY (this repo does NOT use `prisma migrate deploy`).
-- The `add_metrics_after_insert` trigger is present in prod but is dropped at
-- the end of packages/civitai-db-schema/prisma/programmability/metrics_trigger.sql,
-- so confirm live state via `pg_trigger` before/after (not information_schema).

-- a) stop the writer
DROP TRIGGER IF EXISTS add_metrics_after_insert ON "Image";
DROP FUNCTION IF EXISTS add_image_metrics();

-- b) drop the dependent objects that read "ImageMetric".
--    Both views only ever pivoted "ImageMetric" (frozen at zeros since its
--    processor was disabled) and nothing in the app reads them; the ranking
--    proc + auto-feature functions are dead (early RETURN / no callers) and
--    reference the view, so they go too. Views must be dropped before the
--    table, or `DROP TABLE "ImageMetric"` fails with a dependency error.
DROP FUNCTION IF EXISTS feature_images(integer);
DROP FUNCTION IF EXISTS feature_images(text, integer);
DROP PROCEDURE IF EXISTS update_image_rank(integer);
DROP VIEW IF EXISTS "ImageRank_Live";
DROP VIEW IF EXISTS "ImageStat";

-- c) remove from the CDC publication (no-op if already absent)
ALTER PUBLICATION civitai_pg_ch_publication DROP TABLE "ImageMetric";

-- d) drop the table
DROP TABLE IF EXISTS "ImageMetric";

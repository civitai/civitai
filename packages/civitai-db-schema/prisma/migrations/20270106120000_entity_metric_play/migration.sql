-- Adds the `Play` metric type (song plays, sent to ClickHouse `entityMetricEvents` as a string).
-- Order: deploy the regenerated Prisma client first, then apply this by hand. No backfill;
-- no code writes this value to Postgres.
ALTER TYPE "EntityMetric_MetricType_Type" ADD VALUE IF NOT EXISTS 'Play';

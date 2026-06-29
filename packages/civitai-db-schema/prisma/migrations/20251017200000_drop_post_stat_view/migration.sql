-- Drop PostStat view (no longer used - replaced by postStatCache)
-- Stats are now fetched from PostMetric table via Redis cache for better performance
DROP VIEW IF EXISTS "PostStat";

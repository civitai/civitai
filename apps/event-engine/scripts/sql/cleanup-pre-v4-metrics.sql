-- Cleanup Pre-V4 Entity Metrics (Before Backfill)
-- =================================================
-- This script deletes all metric events with version < 4 that were created
-- BEFORE the V4 backfill started for each entity type. This preserves:
--   - All V4 records (the backfill data)
--   - V3 records that came in AFTER the backfill started (live events)
--
-- IMPORTANT: Run this AFTER the V4 backfill is complete.
--
-- Each entity type has its own backfill cutoff (earliest V4 record):
--   ModelVersion: 2026-01-15 18:28:52
--   Model:        2026-01-15 18:37:30
--
-- Records to be deleted (created before each entity's backfill):
--   Model v2:        ~38.5M
--   Model v3:        ~78.7M
--   ModelVersion v2: ~39.5M
--   ModelVersion v3: ~79.3M
--   Total:           ~236M records
--
-- Records preserved (created after backfill started):
--   Model v3:        ~115K (live events)
--   Model v4:        ~3.56M (backfill)
--   ModelVersion v3: ~116K (live events)
--   ModelVersion v4: ~3.62M (backfill)
--
-- This uses ClickHouse's lightweight DELETE which creates mutations.
-- Large deletes are processed asynchronously in the background.

-- =============================================================================
-- Step 0: Find backfill cutoffs (earliest V4 record per entity type)
-- =============================================================================
-- Run this to get the exact cutoff timestamps for each entity type:
--
-- SELECT
--     entityType,
--     min(createdAt) as backfill_cutoff
-- FROM entityMetricEvents_month
-- WHERE version = 4
-- GROUP BY entityType;

-- =============================================================================
-- Step 1: Verify current state before deletion
-- =============================================================================
-- Run this to confirm the data distribution before/after each entity's cutoff:
--
-- SELECT
--     entityType,
--     version,
--     countIf(createdAt < (
--         SELECT min(createdAt)
--         FROM entityMetricEvents_month t2
--         WHERE t2.entityType = entityMetricEvents_month.entityType AND t2.version = 4
--     )) as to_delete,
--     countIf(createdAt >= (
--         SELECT min(createdAt)
--         FROM entityMetricEvents_month t2
--         WHERE t2.entityType = entityMetricEvents_month.entityType AND t2.version = 4
--     )) as to_keep
-- FROM entityMetricEvents_month
-- WHERE entityType IN ('Model', 'ModelVersion')
-- GROUP BY entityType, version
-- ORDER BY entityType, version;

-- =============================================================================
-- Step 2: Delete pre-backfill records for Model
-- =============================================================================
-- Uses Model's specific cutoff: 2026-01-15 18:37:30
ALTER TABLE entityMetricEvents_month
DELETE WHERE entityType = 'Model'
    AND version < 4
    AND createdAt < (
        SELECT min(createdAt)
        FROM entityMetricEvents_month
        WHERE entityType = 'Model' AND version = 4
    );

-- =============================================================================
-- Step 3: Delete pre-backfill records for ModelVersion
-- =============================================================================
-- Uses ModelVersion's specific cutoff: 2026-01-15 18:28:52
ALTER TABLE entityMetricEvents_month
DELETE WHERE entityType = 'ModelVersion'
    AND version < 4
    AND createdAt < (
        SELECT min(createdAt)
        FROM entityMetricEvents_month
        WHERE entityType = 'ModelVersion' AND version = 4
    );

-- =============================================================================
-- Step 4: Check mutation progress
-- =============================================================================
-- Mutations in ClickHouse are asynchronous. Check progress with:
--
-- SELECT
--     database,
--     table,
--     mutation_id,
--     command,
--     create_time,
--     is_done,
--     parts_to_do,
--     latest_fail_reason
-- FROM system.mutations
-- WHERE table = 'entityMetricEvents_month'
--   AND is_done = 0
-- ORDER BY create_time DESC;

-- =============================================================================
-- Step 5: Verify deletion completed
-- =============================================================================
-- Run after mutations finish to confirm only post-backfill data remains:
--
-- SELECT
--     entityType,
--     version,
--     count() as record_count,
--     min(createdAt) as earliest,
--     max(createdAt) as latest
-- FROM entityMetricEvents_month
-- WHERE entityType IN ('Model', 'ModelVersion')
-- GROUP BY entityType, version
-- ORDER BY entityType, version;
--
-- Expected: No records with createdAt < '2026-01-15 18:28:52' for version < 4

-- =============================================================================
-- FUTURE: Update default version to 4 (run after migration fully complete)
-- =============================================================================
-- Once the migration is fully complete and all handlers are producing V4:
-- ALTER TABLE entityMetricEvents_month MODIFY COLUMN version UInt8 DEFAULT 4;

-- resourceIntentShadow: the POOL_MERGE arm. Apply MANUALLY (we do not auto-run DDL), and BEFORE
-- `resourceIntentPoolMerge` is opened in an environment: a POOL_MERGE row sends these six fields,
-- and inserts are async with `wait_for_async_insert = 0`, so a row the table cannot take is lost
-- without an error. HYBRID_10 rows do not send them and read the defaults below, so this is not
-- needed for `resourceIntentJev` alone.
--
--   arm                 'hybrid_10' or 'pool_merge'.
--   coocSnapshotHash    content hash of the co-occurrence snapshot served (a study's, in study
--                       mode); '' when none was served.
--   coocSpecHash        RESOURCE_INTENT_COOC_SPEC_HASH (resource-intent-cooc/spec.ts).
--   poolMergeSpecHash   RESOURCE_INTENT_POOL_MERGE_SPEC_HASH (resource-intent-pool-merge.ts).
--   coocFallback        1 when no production snapshot was served and the list is BASE alone.
--   coocFallbackReason  why: no_snapshot, load_failed, spec_mismatch, snapshot_unservable or
--                       loading.

ALTER TABLE default.resourceIntentShadow
  ADD COLUMN IF NOT EXISTS arm LowCardinality(String) DEFAULT 'hybrid_10',
  ADD COLUMN IF NOT EXISTS coocSnapshotHash String DEFAULT '',
  ADD COLUMN IF NOT EXISTS coocSpecHash String DEFAULT '',
  ADD COLUMN IF NOT EXISTS poolMergeSpecHash String DEFAULT '',
  ADD COLUMN IF NOT EXISTS coocFallback UInt8 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coocFallbackReason LowCardinality(String) DEFAULT '';

-- Fallback rate by reason on the POOL_MERGE arm, last day:
--
--   SELECT coocFallbackReason, count() FROM resourceIntentShadow
--   WHERE time > now() - INTERVAL 1 DAY AND arm = 'pool_merge'
--   GROUP BY 1;

-- resourceIntentShadow: checkpoint mode (`kind: 'checkpoint'`). Apply MANUALLY (we do not auto-run
-- DDL), and BEFORE `resourceIntentCheckpoint` is opened in an environment: a checkpoint row sends
-- these two fields, and inserts are async with `wait_for_async_insert = 0`, so a row the table
-- cannot take is lost without an error. Needs `2026-10-10-resource-intent-shadow-pool-merge.sql`
-- applied first: checkpoint rows also send that migration's six columns. Add-on rows send neither
-- of these and read the defaults below.
--
--   kind                'addon' or 'checkpoint'.
--   checkpointSpecHash  RESOURCE_INTENT_CHECKPOINT_SPEC_HASH (resource-intent-checkpoint.ts).
--
-- On a checkpoint row the pool-merge columns read:
--   arm                 'attach_bm' (served) or 'base_bm' (the study's comparator).
--   coocSnapshotHash    the snapshot whose checkpoint section was served (a study's, in study
--                       mode); '' on base_bm or a fallback.
--   coocSpecHash        RESOURCE_INTENT_COOC_SPEC_HASH on attach_bm; '' on base_bm.
--   poolMergeSpecHash   ''.
--   coocFallback        1 when attach_bm had no servable section and the list is BASE_BM's.
--   coocFallbackReason  no_snapshot, load_failed, spec_mismatch (includes a snapshot with no
--                       checkpoint section), snapshot_unservable or loading.
-- and, since no question spec runs: specHash '', stage3SpecHash '', specVersion 0, role /
-- styleFamily / contentType '', model 'none' (undegraded).
--
-- 🔴 The M4 volume query in `2026-09-29-resource-intent-shadow.sql` counts every row: filter it
-- with `kind = 'addon'` once checkpoint rows exist.

ALTER TABLE default.resourceIntentShadow
  ADD COLUMN IF NOT EXISTS kind LowCardinality(String) DEFAULT 'addon',
  ADD COLUMN IF NOT EXISTS checkpointSpecHash String DEFAULT '';

-- Checkpoint fallback rate by reason, last day:
--
--   SELECT arm, coocFallbackReason, count() FROM resourceIntentShadow
--   WHERE time > now() - INTERVAL 1 DAY AND kind = 'checkpoint'
--   GROUP BY 1, 2;

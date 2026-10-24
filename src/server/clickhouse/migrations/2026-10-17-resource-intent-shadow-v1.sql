-- resourceIntentShadow: the v1_tags arm, served and shadowed. Apply MANUALLY (we do not auto-run
-- DDL), and BEFORE either `resourceIntentV1` or `resourceIntentV1Shadow` is opened in an
-- environment: rows on those paths send these columns, and inserts are async with
-- `wait_for_async_insert = 0`, so a row the table cannot take is lost without an error. Needs
-- `2026-10-10-resource-intent-shadow-pool-merge.sql` and
-- `2026-10-11-resource-intent-shadow-checkpoint.sql` applied first (served v1 rows send the
-- POOL_MERGE columns; the queries below read `kind`). Other rows read the defaults below.
--
-- Still one row per request. A served v1_tags row has `arm = 'v1_tags'`; a row on any other arm
-- whose request ran the shadow carries the v1_tags list it would have served in the shadow* columns.
--
--   shadowArm            'v1_tags' when the shadow was attempted on this row (see shadowReason for
--                        'skipped'), else ''.
--   shadowDegraded       1 when the shadow threw.
--   shadowReason         why the shadow arm would have fallen back (as v1FallbackReason), 'error'
--                        on shadowDegraded, 'skipped' when the pod already had its maximum of
--                        shadows running, '' when it produced a list. Exclude 'skipped' and
--                        'loading' from any shadow-health rate: they mark bursts and cold pods,
--                        not an unhealthy arm.
--   shadowSuggestionIds  the version ids the shadow arm would have served.
--   shadowLatencyMs      the shadow's own wall time, after the response was returned.
--   v1Fallback           1 when a served v1_tags row's list is the POOL_MERGE arm's.
--   v1FallbackReason     a tag-index holder reason (disabled, no_snapshot, loading, load_failed,
--                        snapshot_unservable), no_tags, no_ecosystem, unknown_ecosystem,
--                        no_candidates, or cached_fallback for a fallback replayed from the cache
--                        while an index is held.
--   tagSnapshotHash      payload sha256 of the tag-index snapshot the v1 arm (served or shadow) used.
--   vocabVersion         that snapshot's vocabulary version.
--   tagsSpecHash         RESOURCE_INTENT_TAGS_SPEC_HASH (resource-intent-tags/spec.ts).
--   literalTagCount      how many vocabulary tags were found literally in the prompt, before the
--                        explicit gate. A count, not the ids: no per-prompt bag of tags is kept.
--   explicitTagsRemoved  how many of them the gate removed.
--   ecosystemSource      'caller' (the request's baseModel), 'tags' (tag-derived), or '' when none
--                        was chosen.
--   ecosystemTop3        the tag-derived ecosystems, best first; [] when the caller gave one.
-- On a served row replayed from the cache the per-prompt columns (literalTagCount through
-- ecosystemTop3) hold their defaults (0, '' or []): the tags were not computed.

ALTER TABLE default.resourceIntentShadow
  ADD COLUMN IF NOT EXISTS shadowArm LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS shadowDegraded UInt8 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shadowReason LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS shadowSuggestionIds Array(Int64) DEFAULT [],
  ADD COLUMN IF NOT EXISTS shadowLatencyMs UInt32 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS v1Fallback UInt8 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS v1FallbackReason LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS tagSnapshotHash String DEFAULT '',
  ADD COLUMN IF NOT EXISTS vocabVersion String DEFAULT '',
  ADD COLUMN IF NOT EXISTS tagsSpecHash String DEFAULT '',
  ADD COLUMN IF NOT EXISTS literalTagCount UInt16 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS explicitTagsRemoved UInt16 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ecosystemSource LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS ecosystemTop3 Array(String) DEFAULT [];

-- Shadow outcomes by kind, last day:
--
--   SELECT kind, shadowReason, shadowDegraded, count() FROM resourceIntentShadow
--   WHERE time > now() - INTERVAL 1 DAY AND shadowArm = 'v1_tags'
--   GROUP BY 1, 2, 3;
--
-- Served v1 fallback rate by reason, last day:
--
--   SELECT v1FallbackReason, count() FROM resourceIntentShadow
--   WHERE time > now() - INTERVAL 1 DAY AND arm = 'v1_tags'
--   GROUP BY 1;

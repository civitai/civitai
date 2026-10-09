-- resourceIntentShadow: stage-3 spec hash and the split `none` probabilities. Apply MANUALLY
-- (we do not auto-run DDL), and BEFORE `resourceIntentJev` is opened in an environment: the
-- writer sends these three fields on every row, and inserts are async with
-- `wait_for_async_insert = 0`, so a row the table cannot take is lost without an error.
--
--   stage3SpecHash         RESOURCE_INTENT_STAGE3_SPEC_HASH (resource-intent-stage3.ts). Stage 3
--                          has its own hash; `specHash` covers stage 1 only. Both are in the
--                          cache key, so a row's pair names the spec that produced it.
--   stage1NoneProbability  stage 1's role.none. NULL on a degraded row.
--   stage3NoneProbability  stage 3's `none` mass averaged over its two option orders, as run by
--                          THIS request. NULL when stage 3 did not run (role none, empty
--                          shortlist, degraded) and on a cache hit (the value is not cached). It
--                          never empties the suggestions.
--
-- `noneProbability` stays, unchanged: stage 3's value when stage 3 ran, else stage 1's. Prefer
-- the two split columns.

ALTER TABLE default.resourceIntentShadow
  ADD COLUMN IF NOT EXISTS stage3SpecHash String DEFAULT '',
  ADD COLUMN IF NOT EXISTS stage1NoneProbability Nullable(Float32),
  ADD COLUMN IF NOT EXISTS stage3NoneProbability Nullable(Float32);

-- Stage-3 `none` mass by stage-3 spec, last day:
--
--   SELECT stage3SpecHash, count(), avg(stage3NoneProbability) FROM resourceIntentShadow
--   WHERE time > now() - INTERVAL 1 DAY AND degraded = 0 AND stage3NoneProbability IS NOT NULL
--   GROUP BY 1;

-- ============================================================
-- Turn off the firstDailyFollow and generation-feedback Buzz rewards
-- ============================================================
-- Deprecated at Justin's request. Both rewards keep their definitions and their
-- call sites; this row is what stops them paying, via the `rewards:config`
-- mechanism in src/server/rewards/reward-config.ts.
--
-- Past grants are NOT touched. The Buzz ledger and the ClickHouse `buzzEvents`
-- history stay exactly as they are; this only stops future awards.
--
-- ⚠️ MANUAL APPLY — the main civitai DB does NOT auto-apply migrations. This file
-- is committed for history; a HUMAN applies the SQL below per environment
-- (psql/retool). CI / deploy does NOT run it. Applying it IS the deprecation, so
-- the timing is whoever runs it, not a deploy.
--
-- Reversible without a deploy: set either `enabled` back to true here, or use the
-- `rewardConfig.set` moderator procedure. Verify the live state through
-- GET /api/testing/rewards-config?token=$WEBHOOK_TOKEN, which resolves through
-- the same code path as a grant.
--
-- MERGE, NOT REPLACE. The row is shared by every reward, so this must not clobber
-- overrides someone else set:
--   - Other rewards' entries are preserved.
--   - Other fields on these two entries (`awardAmount`, `cap`) are preserved, so
--     re-enabling restores whatever amount was configured.
--   - ON CONFLICT DO UPDATE rather than DO NOTHING: with DO NOTHING, an existing
--     row would leave both rewards paying while this migration reported success.
--   - A non-object entry (`"firstDailyFollow": false`, `null`) is replaced rather
--     than concatenated, because `||` errors on a non-object jsonb operand.
INSERT INTO "KeyValue" ("key", "value")
VALUES (
  'rewards:config',
  '{"rewards":{"firstDailyFollow":{"enabled":false},"generation-feedback":{"enabled":false}}}'::jsonb
)
ON CONFLICT ("key") DO UPDATE
SET "value" = COALESCE("KeyValue"."value", '{}'::jsonb) || jsonb_build_object(
  'rewards',
  COALESCE(
    CASE
      WHEN jsonb_typeof("KeyValue"."value" -> 'rewards') = 'object'
      THEN "KeyValue"."value" -> 'rewards'
    END,
    '{}'::jsonb
  ) || jsonb_build_object(
    'firstDailyFollow',
    COALESCE(
      CASE
        WHEN jsonb_typeof("KeyValue"."value" #> '{rewards,firstDailyFollow}') = 'object'
        THEN "KeyValue"."value" #> '{rewards,firstDailyFollow}'
      END,
      '{}'::jsonb
    ) || '{"enabled":false}'::jsonb,
    'generation-feedback',
    COALESCE(
      CASE
        WHEN jsonb_typeof("KeyValue"."value" #> '{rewards,generation-feedback}') = 'object'
        THEN "KeyValue"."value" #> '{rewards,generation-feedback}'
      END,
      '{}'::jsonb
    ) || '{"enabled":false}'::jsonb
  )
);

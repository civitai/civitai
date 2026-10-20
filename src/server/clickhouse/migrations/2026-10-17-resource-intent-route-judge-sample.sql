-- p2m_restricted.routeJudgeSample: route prompt text for the judged comparison of the v1_tags arm.
-- Apply MANUALLY (we do not auto-run DDL). Inserts are async with `wait_for_async_insert = 0`, so a
-- row the table cannot take is lost without an error.
--
-- 🔴 The `p2m_restricted` database restricts nothing by itself: a user with a database-wide SELECT
-- reads this table like any other. Before `resourceIntentJudgeCapture` is opened in an environment,
-- in this order: create the table; add its own pair of row policies (one letting only the judged
-- comparison's reader see rows, one hiding them from every other user), applied by an infra owner;
-- grant the app's ClickHouse user INSERT on this table and nothing else on it; then open the flag.
--
-- While the flag is on, every add-on request (cache hits included) writes one row. No column names
-- the caller, the token or the block instance, but `promptHash` is the shadow row's (sha256 hex of
-- the prompt), so a sample joins its served and shadow lists there, and through that row's time to
-- the request itself. Turn the flag off once the sample is complete.

CREATE TABLE IF NOT EXISTS p2m_restricted.routeJudgeSample
(
  time DateTime64(3),
  promptHash String,
  prompt String,
  browsingLevel UInt16,
  baseModel String
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(time)
ORDER BY (time, promptHash)
TTL toDateTime(time) + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;

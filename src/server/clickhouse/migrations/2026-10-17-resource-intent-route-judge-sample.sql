-- p2m_restricted.routeJudgeSample: route prompt text for the judged comparison of the v1_tags arm.
-- Apply MANUALLY (we do not auto-run DDL), and BEFORE `resourceIntentJudgeCapture` is opened in an
-- environment: inserts are async with `wait_for_async_insert = 0`, so a row the table cannot take is
-- lost without an error. The app's ClickHouse user needs INSERT on this table and nothing else on
-- it; reading it is for the judged comparison only.
--
-- While the flag is on, every add-on request (cache hits included) writes one row. Nothing here
-- identifies the caller, the token or the block instance. `promptHash` is the shadow row's
-- (sha256 hex of the prompt), so a sample joins its served and shadow lists there. Rows expire
-- after 30 days; turn the flag off once the sample is complete.

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

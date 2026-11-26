-- App Assistant turns — ClickHouse DDL. Apply MANUALLY, before the `app-assistant-tracing` Flipt
-- flag is turned on. Rows are inserted app-side (src/server/services/app-assistant/
-- session-tracing.service.ts, direct insert), not through the tracker service, so no tracker restart
-- is needed. While the table is missing an insert fails (or is dropped by the async insert) and is
-- logged; a turn never fails or waits on it.
--
-- One row per finished App Assistant turn on the server runner, with or without an app chosen, so
-- builds abandoned before any submit are counted too. Ids, counts and timings only: no message
-- text, no tool input or output.

CREATE TABLE IF NOT EXISTS default.appAssistantTurns
(
  -- when the turn ended
  time DateTime64(3),
  startedAt DateTime64(3),
  userId UInt32,
  conversationId String,
  -- the app the chat had chosen as the turn ended; '' = none yet
  appSlug String,
  seq UInt32,
  runId String,
  model LowCardinality(String),
  -- done | error | stopped | ran_out
  status LowCardinality(String),
  buzz Float64,
  durationMs UInt32,
  toolCallCount UInt32,
  -- calls per tool name, e.g. {'read_docs': 3, 'sandbox__write_file': 12}
  toolCalls Map(LowCardinality(String), UInt32)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(time)
ORDER BY (userId, conversationId, time)
TTL toDateTime(time) + INTERVAL 365 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Verify after the flag is on (a staff account sends one App Assistant message first):
--
--   SELECT status, count(), sum(buzz) FROM appAssistantTurns
--   WHERE time > now() - INTERVAL 1 HOUR GROUP BY status;
--
-- Apps whose chats went quiet over 7 days ago (an abandoned build is one of these with no publish
-- request; that half lives in Postgres, app_block_publish_requests.slug):
--
--   SELECT appSlug, uniqExact(conversationId) AS chats, max(time) AS lastTurn
--   FROM appAssistantTurns WHERE appSlug != '' GROUP BY appSlug
--   HAVING lastTurn < now() - INTERVAL 7 DAY;

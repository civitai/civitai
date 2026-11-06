-- Image upload requests — ClickHouse DDL. Apply MANUALLY, BEFORE the code that writes it deploys.
-- The tracker reads table schemas when it connects, so a table created after it started is unknown
-- to it until it is restarted (ask an infra owner). Then confirm with a real event: upload an image
-- while signed in, and
--   SELECT count() FROM default.imageUploadRequests WHERE time > now() - INTERVAL 1 HOUR
-- must be non-zero. A zero without that upload proves nothing.
--
-- One row per image upload key the server hands out: who asked, from which IP, for which key (the
-- key that becomes `Image.url`). Its own table, not `actions`, so the rows expire after 12 months.

CREATE TABLE IF NOT EXISTS default.imageUploadRequests
(
  time DateTime64(3) DEFAULT now64(3),
  userId UInt32,
  ip String,
  key String
)
ENGINE = MergeTree
ORDER BY (userId, time)
TTL toDateTime(time) + INTERVAL 12 MONTH;

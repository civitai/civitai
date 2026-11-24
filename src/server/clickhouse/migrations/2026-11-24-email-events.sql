-- General email measurement: one row per event for every email civitai sends — ClickHouse DDL.
--
-- 🔴 MANUAL. Apply this by hand, BEFORE (or soon after) the release that writes send rows is
-- deployed. We do not auto-run DDL. Rows are inserted app-side (src/server/email/send-tracking.ts,
-- a direct insert called by the one transport in @civitai/email after each successful send), not
-- through the tracker service, so no tracker restart is needed. While the table is missing no row
-- lands (the client inserts asynchronously, so the error may not reach the app's log) and every
-- send still goes out: the transport never fails a send on its recorder and never waits on it.
--
-- One row per event. A `send` row is one message the transport accepted (never a skipped or
-- failed send), from the main app. The digest also keeps its own notificationDigestEvents rows.
--
-- `sendId` is our own UUID per message, also sent as the message's `X-Civitai-Send-Id` header: the
-- relay replaces the Message-ID, so that header is the only key a later delivery event can join on.
-- No address, and no hash of one, is ever stored here: rows name a user only by id (0 = unknown).
--
-- ORDER BY (template, event, time): the reads are per-template rates over a time window (sends,
-- then later deliveries, bounces and clicks, per template and class), so template and event lead
-- and time ranges stay contiguous inside each. PARTITION BY month bounds a window scan to the
-- months it covers and lets the TTL drop whole parts (ttl_only_drop_parts). TTL 400 days keeps a
-- year-over-year comparison, matching notificationDigestEvents. Columns a later event needs (a
-- bounce type, a link position, a user agent) are an ADD COLUMN, a metadata-only change.

CREATE TABLE IF NOT EXISTS default.emailEvents
(
  -- when the event happened (send rows: when the transport accepted the message)
  time DateTime64(3),
  -- the event kind, e.g. send
  event LowCardinality(String),
  -- our per-message id, the X-Civitai-Send-Id header
  sendId UUID,
  -- the sender's stable key: a template's (e.g. trainingComplete) or a named one-off sender's
  template LowCardinality(String),
  -- transactional | lifecycle
  mailClass LowCardinality(String),
  -- the send's campaign ('' when none); the digest: its pass, as an ISO timestamp
  campaign LowCardinality(String),
  variant LowCardinality(String),
  -- the recipient's user id when the sender knows it, else 0
  userId UInt32
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(time)
ORDER BY (template, event, time)
TTL toDateTime(time) + INTERVAL 400 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Verify, AFTER applying:
--
--   SHOW CREATE TABLE default.emailEvents;
--
-- Positive control once the release is live and any email has been sent:
--
--   SELECT template, mailClass, count(), uniqExact(sendId)
--   FROM default.emailEvents
--   WHERE event = 'send' AND time > now() - INTERVAL 1 DAY
--   GROUP BY template, mailClass ORDER BY count() DESC;
--     -- a day with sends must show non-zero counts, and count() = uniqExact(sendId). Zero rows
--     -- while mail is going out means the inserts are not landing. Axiom's "email send could not
--     -- be recorded" may show why, but can be empty even then. A row with template = '' is a
--     -- sender that reached the transport untagged.

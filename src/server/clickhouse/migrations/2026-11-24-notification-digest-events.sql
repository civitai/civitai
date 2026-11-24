-- Weekly missed-notification digest measurement — ClickHouse DDL.
--
-- 🔴 MANUAL. Apply this by hand, BEFORE the release carrying the digest click tracking is deployed
-- (or at least before its next weekly pass). We do not auto-run DDL. Rows are inserted app-side
-- (src/server/notifications/digest-tracking.ts, a direct insert), not through the tracker service,
-- so no tracker restart is needed. While the table is missing every insert fails and is logged
-- ("digest events could not be recorded"); sends, click redirects and unsubscribes still work.
--
-- One row per event:
--   send         one per digest actually sent (never a start floor, a skip or a failed send)
--   click        one per followed link in a digest (GET of /api/notifications/digest-click with a
--                valid signed link); the user and pass come from the link, not the session
--   unsubscribe  one per digest opt-out made from a digest's unsubscribe link (only the request
--                that turned it off)
-- `cycleStartedAt` is the pass (DigestCursor.cycleStartedAt); a pass's click-through is
-- uniqExact clickers / uniqExact senders over the rows sharing it. Ids and counts only, plus the
-- click's user agent (so link scanners can be told apart at read time).

CREATE TABLE IF NOT EXISTS default.notificationDigestEvents
(
  -- when the row was written
  time DateTime64(3),
  -- send | click | unsubscribe
  event LowCardinality(String),
  userId UInt32,
  -- the pass; 1970-01-01 on an unsubscribe from a link that names none
  cycleStartedAt DateTime64(3),
  -- send rows: the time recorded as the user's last digest (the moment the unseen list was read)
  sentAt DateTime64(3),
  -- send rows: items listed in the email
  itemCount UInt16,
  -- click rows: the item's 1-based position; 0 = the "See all notifications" button
  position UInt16,
  -- click rows: the clicked notification's type; '' for the button
  notificationType LowCardinality(String),
  -- click rows: the request's User-Agent, at most 512 characters
  userAgent String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(time)
ORDER BY (cycleStartedAt, event, userId, time)
TTL toDateTime(time) + INTERVAL 400 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Verify, AFTER applying:
--
--   SHOW CREATE TABLE default.notificationDigestEvents;
--
-- Positive control once the release is live and a pass has sent at least one digest:
--
--   SELECT cycleStartedAt, event, count(), uniqExact(userId)
--   FROM default.notificationDigestEvents
--   GROUP BY cycleStartedAt, event ORDER BY cycleStartedAt DESC, event;
--     -- a pass that sent must show a non-zero `send` count. Zero sends after a pass whose Axiom
--     -- "digest run finished" line reports emailed > 0 means the inserts are failing: search Axiom
--     -- for "digest events could not be recorded".

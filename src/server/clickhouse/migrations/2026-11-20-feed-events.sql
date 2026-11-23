-- Feed events — ClickHouse DDL. Apply MANUALLY, BEFORE the release that accepts the `feed` beacon
-- kind. Rows are inserted app-side (src/server/services/feed-events.service.ts, direct async insert),
-- not through the tracker service, so no tracker restart is needed.
--
-- One row per feed event from the browser: a page of a feed loaded, the items of that page that
-- passed the impression dwell check (seen), or a click on one. Every row carries the feed context,
-- so filter, sort and position questions are a GROUP BY. What users are told about this table:
-- docs/features/feed-events.md.
--
-- No ip, no user agent, no URL, no free text. userId and memberType come from the session.
-- Sampled per browser session at the rate set by the Flipt variant `feed-events-sample-rate`
-- (variant key = rate, e.g. "0.1"); no variant = off.

CREATE TABLE IF NOT EXISTS default.feedEvents
(
  time DateTime64(3),
  event LowCardinality(String),
  userId UInt32,
  -- session tier; 'undefined' = free or signed out (same stamp as pageViews.memberType)
  memberType LowCardinality(String),
  -- random per-tab token, the one impressions use; not tied to a person
  sessionKey String,
  feed LowCardinality(String),
  -- route pattern, e.g. /models or /user/[username]/models; unknown routes are 'other'
  page LowCardinality(String),
  sort LowCardinality(String),
  pageIndex UInt16,
  filters Map(LowCardinality(String), String),
  -- click rows only
  entityType LowCardinality(String),
  entityId UInt32,
  position UInt16,
  -- seen rows only
  seenIds Array(UInt32)
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(time)
ORDER BY (feed, event, time)
TTL toDateTime(time) + INTERVAL 90 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Verify after the Flipt rate is above 0 (a staff account loads /models first):
--
--   SELECT feed, event, count(), uniqExact(sessionKey) FROM feedEvents
--   WHERE time > now() - INTERVAL 1 HOUR GROUP BY feed, event;
--
-- Hide Paid share by member tier, signed-in /models loads:
--
--   SELECT memberType != 'undefined' AS member,
--          uniqExactIf(userId, filters['hidePaid'] = 'true') / uniqExact(userId) AS hidePaidShare
--   FROM feedEvents
--   WHERE event = 'load' AND feed = 'models' AND userId > 0 AND time > now() - INTERVAL 14 DAY
--   GROUP BY member;

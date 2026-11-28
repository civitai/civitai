-- The viewer's personal-hot-lead flag on feed events — ClickHouse DDL.
--
-- 🔴 MANUAL. Apply this by hand, before or soon after the release that sends the tag. We do not
-- auto-run DDL. ADD COLUMN on a MergeTree table is metadata only: no rewrite of existing parts, and
-- existing rows read NULL.
--
-- Before it is applied: rows are inserted with `input_format_skip_unknown_fields = 1`
-- (src/server/services/feed-events.service.ts), so they still land, without the tag. Rows recorded
-- before this is applied cannot get it back.
--
-- What it holds: whether the signed-in viewer had the `personal-hot-lead` Flipt flag on, stamped by
-- the server from the session once per beacon batch, through the same evaluation getModelsFeed uses
-- (isPersonalHotLeadViewer). NULL: signed out (no cohort), or a row from before this release. Set on
-- load, seen and click rows.

ALTER TABLE default.feedEvents
  ADD COLUMN IF NOT EXISTS personalHotLead Nullable(Bool) AFTER seenIds;

-- Verify, AFTER applying:
--
--   SHOW CREATE TABLE default.feedEvents;
--     -- personalHotLead Nullable(Bool) follows seenIds.
--
-- Positive control once the release is live (a signed-in account loads /models):
--
--   SELECT personalHotLead, event, count(), uniqExact(userId)
--   FROM default.feedEvents
--   WHERE feed = 'models' AND userId > 0 AND time > now() - INTERVAL 1 HOUR
--   GROUP BY personalHotLead, event;
--     -- signed-in rows split into true and false. All NULL for signed-in viewers an hour after the
--     -- release means the tag is not being sent.

-- Click columns on the general email events table — ClickHouse DDL.
--
-- 🔴 MANUAL. Apply this by hand, BEFORE (or soon after) the release carrying tracked email links is
-- deployed. We do not auto-run DDL. Both are ADD COLUMN, a metadata-only change on a MergeTree
-- table: no rewrite of existing parts, existing rows read the defaults (0 and '').
--
-- What happens before it is applied: send rows are unchanged (they never carry these columns).
-- Click and unsubscribe rows are inserted with `input_format_skip_unknown_fields = 1`
-- (src/server/email/send-tracking.ts insertEmailEvents), so they still land, without the link
-- position and the user agent. Clicks recorded before this is applied cannot get them back.
--
-- New event kinds on the same table (no DDL needed for them, `event` is a string):
--   click        one per followed tracked link (GET of /api/email/click with a valid signed link,
--                or of the digest's /api/notifications/digest-click when its link carries the send
--                id); the send, template, campaign, variant, user and position come from the link,
--                never the session
--   unsubscribe  one per lifecycle opt-out made from that email's unsubscribe link (only the request
--                that turned it off), carrying the send id its link named
--
-- Mail security scanners that GET every link are recorded as clicks. Some announce themselves in
-- the user agent; many send a browser-like one, so the other tells are a click within seconds of
-- the send row, or every position of one email clicked at once. Filter at read time.

ALTER TABLE default.emailEvents
  -- click rows: the link's 1-based place among the email's tracked links. The digest: its item
  -- position (0 for its "See all notifications" button) through digest-click, and 101 upward for
  -- its settings and footer links; 0 on every other row
  ADD COLUMN IF NOT EXISTS position UInt16 DEFAULT 0 AFTER userId,
  -- click rows: the request's User-Agent, at most 512 characters; '' on every other row
  ADD COLUMN IF NOT EXISTS userAgent String DEFAULT '' AFTER position;

-- Verify, AFTER applying:
--
--   SHOW CREATE TABLE default.emailEvents;
--     -- position UInt16 and userAgent String follow userId.
--
-- Positive control once the release is live and a tracked email has been clicked:
--
--   SELECT template, event, count(), countIf(position > 0), uniqExact(sendId)
--   FROM default.emailEvents
--   WHERE event IN ('click', 'unsubscribe') AND time > now() - INTERVAL 7 DAY
--   GROUP BY template, event ORDER BY count() DESC;
--     -- clicks after this was applied carry a position (the digest's button is 0). Zero click rows
--     -- in a week with sends of a template that has links means the inserts are not landing.

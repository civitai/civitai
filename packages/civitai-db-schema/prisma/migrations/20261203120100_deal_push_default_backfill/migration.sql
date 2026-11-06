-- One-off backfill, applied by hand. Safe to re-run: ON CONFLICT DO NOTHING, and the skip below.
--
-- The Creator Services deal notifications are push-on by default. New browser grants get them from
-- DEFAULT_PUSH_TYPES; this gives them to users who already held a push subscription. A user who
-- holds ANY deal push row has already made a choice about deal push and is left alone, so a re-run
-- (or a run after someone turned one off) never turns a deal type back on for them.

INSERT INTO "UserPushSetting" ("userId", "type")
SELECT s."userId", t."type"
FROM (SELECT DISTINCT "userId" FROM "PushSubscription") s
CROSS JOIN unnest(ARRAY[
  'service-deal-requested',
  'service-deal-accepted',
  'service-deal-declined',
  'service-deal-expired',
  'service-deal-delivered',
  'service-deal-revision-requested',
  'service-deal-cancellation-requested',
  'service-deal-completed',
  'service-deal-paid-out'
]) AS t("type")
WHERE NOT EXISTS (
  SELECT 1 FROM "UserPushSetting" u
  WHERE u."userId" = s."userId" AND u."type" LIKE 'service-deal-%'
)
ON CONFLICT DO NOTHING;

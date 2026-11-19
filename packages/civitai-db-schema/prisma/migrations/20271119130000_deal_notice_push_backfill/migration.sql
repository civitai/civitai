-- One-off backfill, applied by hand. Safe to re-run: ON CONFLICT DO NOTHING, and the skip below.
--
-- The deal notices added for disputes, cancellations and reminders are push-on by default.
-- New browser grants get them from DEFAULT_PUSH_TYPES; this gives them to users who already held a
-- push subscription and still take deal push. A subscriber with no deal push row turned deal push
-- off and is left alone, as is anyone holding any of the new types (a re-run, or a later choice).

INSERT INTO "UserPushSetting" ("userId", "type")
SELECT s."userId", t."type"
FROM (SELECT DISTINCT "userId" FROM "PushSubscription") s
CROSS JOIN unnest(ARRAY[
  'service-deal-disputed',
  'service-deal-dispute-resolved',
  'service-deal-cancellation-accepted',
  'service-deal-cancellation-declined',
  'service-deal-cancelled',
  'service-deal-auto-complete-soon',
  'service-deal-due-soon',
  'service-deal-overdue'
]) AS t("type")
WHERE EXISTS (
  SELECT 1 FROM "UserPushSetting" u
  WHERE u."userId" = s."userId" AND u."type" IN (
    'service-deal-requested',
    'service-deal-accepted',
    'service-deal-declined',
    'service-deal-expired',
    'service-deal-delivered',
    'service-deal-revision-requested',
    'service-deal-cancellation-requested',
    'service-deal-completed',
    'service-deal-paid-out'
  )
)
AND NOT EXISTS (
  SELECT 1 FROM "UserPushSetting" u
  WHERE u."userId" = s."userId" AND u."type" IN (
    'service-deal-disputed',
    'service-deal-dispute-resolved',
    'service-deal-cancellation-accepted',
    'service-deal-cancellation-declined',
    'service-deal-cancelled',
      'service-deal-auto-complete-soon',
    'service-deal-due-soon',
    'service-deal-overdue'
  )
)
ON CONFLICT DO NOTHING;

-- One-off backfill, applied by hand, once: a re-run would turn the push back on for anyone who
-- turned it off since. (ON CONFLICT DO NOTHING only keeps a re-run from failing.)
--
-- The review reminder is push-on by default. New browser grants get it from the default push
-- types; this gives it to users who already hold a push subscription and still take deal push.
-- A subscriber with no deal push row turned deal push off and is left alone.
--
-- Reversal: DELETE FROM "UserPushSetting" WHERE "type" = 'service-deal-review-due';

INSERT INTO "UserPushSetting" ("userId", "type")
SELECT s."userId", 'service-deal-review-due'
FROM (SELECT DISTINCT "userId" FROM "PushSubscription") s
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
ON CONFLICT DO NOTHING;

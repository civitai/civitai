-- Preserve opt-out state when splitting `contest-collection-item-status-change` into the
-- `collection-item-accepted` / `collection-item-rejected` notification types. Every user who had
-- disabled the old combined notification gets equivalent disabled rows for the two new types so
-- they are not silently re-subscribed by the key change.
INSERT INTO "UserNotificationSettings" ("userId", "type", "disabledAt")
SELECT s."userId", t."type", s."disabledAt"
FROM "UserNotificationSettings" s
CROSS JOIN (VALUES ('collection-item-accepted'), ('collection-item-rejected')) AS t("type")
WHERE s."type" = 'contest-collection-item-status-change'
ON CONFLICT ("userId", "type") DO NOTHING;

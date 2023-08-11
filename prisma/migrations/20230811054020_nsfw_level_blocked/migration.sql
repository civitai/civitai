-- AlterEnum
ALTER TYPE "NsfwLevel" ADD VALUE 'Blocked';

-- Update blocked tags
UPDATE "Tag" SET nsfw = 'Blocked' WHERE name IN ('self injury', 'hanging', 'hate symbols', 'nazi party', 'white supremacy', 'extremist');

-- Transition from 'Allow' to 'Hidden'
INSERT INTO "TagEngagement"("userId", "tagId", type, "createdAt")
WITH target_users AS (
  SELECT DISTINCT
      "userId"
    FROM "TagEngagement"
    WHERE type = 'Allow'
), mod_tags AS (
    SELECT id "tagId" FROM "Tag" WHERE type = 'Moderation'
)
SELECT
  u."userId",
  mt."tagId",
  'Hide' "type",
  '2023-12-27'
FROM target_users u
JOIN mod_tags mt ON true
WHERE NOT EXISTS (
  SELECT 1 FROM "TagEngagement" te
  WHERE te."tagId" = mt."tagId"
    AND te."userId" = u."userId"
    AND te.type = 'Allow'
)
ON CONFLICT ("userId", "tagId") DO UPDATE SET
    type = excluded.type,
    "createdAt" = excluded."createdAt";

-- Remove old Allow tag engagements
DELETE FROM "TagEngagement" WHERE type = 'Allow';

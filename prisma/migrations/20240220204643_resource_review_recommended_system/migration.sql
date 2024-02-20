-- Create favorite collection before migrating to Notify engagement type
INSERT INTO "Collection" ("userId", "name", "description", "type", "availability", "mode")
(
    SELECT 
        DISTINCT "userId",
        'Favorite Models' "name",
        'Your liked models will appear in this collection.',
        'Model'::"CollectionType" "type",
        'Unsearchable'::"Availability" "availability",
        'Bookmark'::"CollectionMode"
    FROM "ModelEngagement"
)
ON CONFLICT DO NOTHING;

-- Copy over all their favorite models onto the new collection. Note - This is heavy.
INSERT INTO "CollectionItem" ("collectionId", "modelId", "createdAt", "addedById")
(
  SELECT 
    c."id" "collectionId",
    "modelId" "modelId",
    NOW() "createdAt",
    me."userId" "addedById"
  FROM "ModelEngagement" me
  JOIN "Collection" c ON c."userId" = me."userId" AND c."type" = 'Model' AND c."mode" = 'Bookmark'
  WHERE me."type" = 'Favorite'
)
ON CONFLICT DO NOTHING;

ALTER TYPE "ModelEngagementType" ADD VALUE 'Mute';
ALTER TYPE "ModelEngagementType" ADD VALUE 'Notify';
-- Update the engagement type to Notify
UPDATE "ModelEngagement" SET "type" = 'Notify' WHERE "type" = 'Favorite';

-- AlterTable
ALTER TABLE "ModelMetric" ADD COLUMN     "thumbsDownCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "thumbsUpCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ModelVersionMetric" ADD COLUMN     "thumbsDownCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "thumbsUpCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ResourceReview" ADD COLUMN     "recommended" BOOLEAN NOT NULL;
UPDATE "ResourceReview"
SET "recommended" = CASE
    WHEN "rating" >= 3 THEN true
    WHEN "rating" > 0 AND "rating" < 3 THEN false
    ELSE NULL
END;

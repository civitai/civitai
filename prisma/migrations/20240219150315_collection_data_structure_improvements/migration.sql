BEGIN;
-- AlterEnum
ALTER TYPE "CollectionMode" ADD VALUE 'Bookmark';

-- CreateIndex
CREATE INDEX "Collection_type_idx" ON "Collection" USING HASH ("type");

-- CreateIndex
CREATE INDEX "Collection_mode_idx" ON "Collection" USING HASH ("mode");

-- CreateIndex
CREATE INDEX "CollectionContributor_userId_idx" ON "CollectionContributor" USING HASH ("userId");
COMMIT;
 
BEGIN;
-- Ensure users have a single Bookmark collection of each type:
CREATE UNIQUE INDEX "User_bookmark_collection" ON "Collection"("userId", "type", "mode")
WHERE ("mode" = 'Bookmark');

-- Create collection for all existing users:
INSERT INTO "Collection" ("userId", "name", "description", "type", "availability", "mode")
(
    SELECT 
        DISTINCT "userId",
        'Bookmarked Articles' "name",
        'Your bookmarked articles will appear in this collection.',
        'Article'::"CollectionType" "type",
        'Unsearchable'::"Availability" "availability",
        'Bookmark'::"CollectionMode"
    FROM "ArticleEngagement"
)
ON CONFLICT DO NOTHING;

-- Copy over all their bookmarks onto the new collection. Note - This is heavy.
INSERT INTO "CollectionItem" ("collectionId", "articleId", "createdAt", "addedById")
(
  SELECT 
    c."id" "collectionId",
    "articleId" "articleId",
    NOW() "createdAt",
    ae."userId" "addedById"
  FROM "ArticleEngagement" ae
  JOIN "Collection" c ON c."userId" = ae."userId" AND c."type" = 'Article' AND c."mode" = 'Bookmark'
  WHERE ae."type" = 'Favorite'
)
ON CONFLICT DO NOTHING;
COMMIT;

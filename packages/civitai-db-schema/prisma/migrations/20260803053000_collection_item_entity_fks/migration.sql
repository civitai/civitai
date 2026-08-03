-- APPLIED TO PROD 2026-08-03. Recorded here for history; see
-- scripts/oneoffs/cleanup-collection-item-orphans.mjs for the batched runner that was used.
--
-- schema.prisma has always declared onDelete: Cascade for CollectionItem's imageId, postId,
-- articleId and modelId, but none of those foreign keys existed in the database. Deleting the
-- referenced entity left the collection row behind: invisible to any query that joins it, yet
-- still counted as pending in review queues.
--
-- Orphans found: imageId 236,521 / postId 10,993 / modelId 1,972 / articleId 288.
--
-- Images alone are deleted from four places, two of them raw SQL and one a bulk deleteMany, so
-- application-level cleanup could not be made airtight.
--
-- Run the steps in order. Step 2 cannot be validated while orphans remain. Deleting ~250k rows in
-- one statement is avoidable -- the script batches at 5,000 -- but the plain form is kept here for
-- readability.

-- Step 1: clear existing orphans.
DELETE FROM "CollectionItem" ci WHERE ci."imageId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Image" x WHERE x.id = ci."imageId");
DELETE FROM "CollectionItem" ci WHERE ci."postId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Post" x WHERE x.id = ci."postId");
DELETE FROM "CollectionItem" ci WHERE ci."articleId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Article" x WHERE x.id = ci."articleId");
DELETE FROM "CollectionItem" ci WHERE ci."modelId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Model" x WHERE x.id = ci."modelId");

-- Step 2: add each constraint without scanning the table. Brief ACCESS EXCLUSIVE lock only.
ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_imageId_fkey"
  FOREIGN KEY ("imageId") REFERENCES "Image"(id) ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "Post"(id) ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_articleId_fkey"
  FOREIGN KEY ("articleId") REFERENCES "Article"(id) ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_modelId_fkey"
  FOREIGN KEY ("modelId") REFERENCES "Model"(id) ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

-- Step 3: validate. SHARE UPDATE EXCLUSIVE, so reads and writes continue. Took 41s / 8s / 0s / 17s.
ALTER TABLE "CollectionItem" VALIDATE CONSTRAINT "CollectionItem_imageId_fkey";
ALTER TABLE "CollectionItem" VALIDATE CONSTRAINT "CollectionItem_postId_fkey";
ALTER TABLE "CollectionItem" VALIDATE CONSTRAINT "CollectionItem_articleId_fkey";
ALTER TABLE "CollectionItem" VALIDATE CONSTRAINT "CollectionItem_modelId_fkey";

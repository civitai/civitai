-- CollectionItem."imageId" has never had a foreign key, so deleting an Image leaves the collection
-- row behind. Those orphans are invisible to any query that joins Image, but still count as
-- pending in review queues: 236,512 across the table as of 2026-08-03, 866 of them in REVIEW.
--
-- Images are deleted from at least four places, two of them raw SQL and one a bulk deleteMany, so
-- application-level cleanup cannot be made airtight. The constraint is the only fix that holds.
--
-- RUN THE STEPS SEPARATELY. Step 2 cannot be validated while orphans exist, and step 3 scans the
-- whole table.

-- Step 1: clear existing orphans. Anti-join over ~210M rows, expect a couple of minutes.
DELETE FROM "CollectionItem" ci
WHERE ci."imageId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Image" i WHERE i.id = ci."imageId");

-- Step 2: add the constraint without checking existing rows. Brief ACCESS EXCLUSIVE lock only.
-- CollectionItem_imageId_idx (plain btree) backs the cascade lookup.
ALTER TABLE "CollectionItem"
  ADD CONSTRAINT "CollectionItem_imageId_fkey"
  FOREIGN KEY ("imageId") REFERENCES "Image"(id)
  ON UPDATE CASCADE ON DELETE CASCADE
  NOT VALID;

-- Step 3: validate. Takes SHARE UPDATE EXCLUSIVE, so reads and writes continue.
ALTER TABLE "CollectionItem" VALIDATE CONSTRAINT "CollectionItem_imageId_fkey";

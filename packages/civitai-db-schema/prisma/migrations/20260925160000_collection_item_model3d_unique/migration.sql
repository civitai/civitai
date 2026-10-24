-- saveItemInCollections upserts with ON CONFLICT ("collectionId", "model3dId") WHERE "model3dId" IS NOT NULL,
-- which needs a matching partial unique index — the sibling entity types each have one.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "CollectionItem_model3d_idx"
  ON "CollectionItem" ("collectionId", "model3dId")
  WHERE "model3dId" IS NOT NULL;

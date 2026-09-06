-- Index `Collection."imageId"` so a deleted image can find the collections whose COVER it is.
--
-- The collections search index denormalizes a cover image onto every collection document, and
-- CollectionCard renders `if (data.image) return [data.image]` — the cover wins over item images.
-- `Collection.imageId -> Image` is `onDelete: SetNull`, so deleting a cover image leaves the
-- document holding a dead thumbnail with no CollectionItem row pointing at it. The reindex enqueue
-- therefore has to look the collection up BY that column.
--
-- Without this index that lookup is a parallel sequential scan of a ~17.3M-row / 4.9 GB table
-- (measured cost 451,531, against ~10,000 for every other leg of the same query combined), on a
-- user-facing image-delete path. With it the leg is an index probe.
--
-- 🔴 APPLY THIS BEFORE DEPLOYING the collections-reindex change that reads it. Migrations here are
-- applied by hand, so the ordering is a human step, not something the deploy enforces.
--
-- CONCURRENTLY cannot run inside a transaction block; run this statement on its own.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Collection_imageId_idx" ON "Collection" ("imageId")
  WHERE "imageId" IS NOT NULL;

-- CreateIndex
-- Partial index for public, searchable collections to speed up search index sync
-- This covers ~70K rows instead of scanning 13.5M collections
CREATE INDEX CONCURRENTLY "Collection_public_searchable_idx"
ON "Collection" ("id")
WHERE "read" = 'Public' AND "userId" != -1 AND "availability" != 'Unsearchable';

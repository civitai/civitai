-- Serves the collectedCount recount for articles (src/server/metrics/collection-item-counts.ts),
-- which looks up every CollectionItem row of a set of articles. No index leads with "articleId":
-- the article uniques and the dedup index all lead with "collectionId", so without this every
-- recount batch scans all of the partial CollectionItem_article_idx (every article row) and then
-- the heap. Mirrors CollectionItem_postId_lookup (which exists in prod but in no migration):
-- partial on the column, carrying what the count reads, so the lookup goes straight to the
-- article's rows.
--
-- Partial and INCLUDE, so it lives only here; schema.full.prisma cannot declare either.
--
-- Apply BEFORE the code that recounts from it deploys. It holds only the article rows (~336k),
-- but CONCURRENTLY still reads the whole table (~204M rows) to build it. Run it OUTSIDE a
-- transaction. A cancelled build leaves an INVALID index that IF NOT EXISTS then skips, so check
-- indisvalid before trusting a re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CollectionItem_articleId_lookup"
  ON "CollectionItem" ("articleId") INCLUDE ("collectionId", "addedById", status)
  WHERE "articleId" IS NOT NULL;

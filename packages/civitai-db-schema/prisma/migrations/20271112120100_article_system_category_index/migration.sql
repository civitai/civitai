-- Index for the Article.systemCategoryId foreign key, so a Tag delete's ON DELETE SET NULL is an
-- index lookup instead of a scan of "Article". Apply AFTER 20271112120000_article_system_category.
-- CONCURRENTLY: run it on its own, outside a transaction (so no BEGIN/ROLLBACK dry run).
-- IF NOT EXISTS also skips an INVALID index left by an interrupted build; after applying, check
-- pg_index.indisvalid, and if false, DROP INDEX CONCURRENTLY and run it again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Article_systemCategoryId_idx"
  ON "Article" ("systemCategoryId");

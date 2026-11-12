-- Article.systemCategoryId: the article category the text scan's category call assigned, kept apart
-- from the author's pick (TagsOnArticle). Written by the category callback only; nothing reads it yet.
--
-- NOT AUTO-APPLIED: a human runs this file by hand (see CLAUDE.md -> Database), dev first, then
-- production. Until it exists, the category write fails, which the callback logs and drops. The safety
-- scan does not depend on it.
--
-- Additive and idempotent; safe to re-run. The foreign key is added NOT VALID and validated after, so
-- the lock on "Article" lasts only as long as the catalog change.

SET lock_timeout = '5s';

ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS "systemCategoryId" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Article_systemCategoryId_fkey'
  ) THEN
    ALTER TABLE "Article"
      ADD CONSTRAINT "Article_systemCategoryId_fkey"
      FOREIGN KEY ("systemCategoryId") REFERENCES "Tag"("id")
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

ALTER TABLE "Article" VALIDATE CONSTRAINT "Article_systemCategoryId_fkey";

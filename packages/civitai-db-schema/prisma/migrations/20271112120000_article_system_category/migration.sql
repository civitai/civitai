-- Article.systemCategoryId: system-assigned category, separate from the author's pick (TagsOnArticle).
-- Apply by hand BEFORE the code deploys (CLAUDE.md -> Database).

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

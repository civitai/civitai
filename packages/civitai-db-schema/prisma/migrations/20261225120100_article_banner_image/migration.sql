-- Articles: an optional wide banner image shown across the top of the article page.
-- Article.coverId stays the card cover used in feeds.
--
-- MANUAL APPLY: a human applies this per environment BEFORE the code that reads the column ships.
-- Additive and idempotent. The column is nullable with no default (catalog-only). The unique index
-- is built over an all-NULL column. The foreign key is added NOT VALID, then validated, so "Image"
-- is only locked briefly; the lock timeout makes a busy table fail fast so a statement can be retried.
SET lock_timeout = '3s';

ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS "bannerId" INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS "Article_bannerId_key" ON "Article"("bannerId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Article_bannerId_fkey') THEN
    ALTER TABLE "Article" ADD CONSTRAINT "Article_bannerId_fkey"
      FOREIGN KEY ("bannerId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

ALTER TABLE "Article" VALIDATE CONSTRAINT "Article_bannerId_fkey";

-- Storylines: the owner's chosen feed card picture and page banner, and the banner's focus.
--
-- MANUAL APPLY: a human applies this per environment, after 20261024120000_storyline_chapter_removed,
-- BEFORE the code that reads these columns ships. Additive: two nullable columns and one with a
-- constant default (no table rewrite). Each foreign key briefly locks "Image"; the lock timeout
-- makes a busy table fail fast so the statement can be retried.
SET lock_timeout = '3s';

ALTER TABLE "Storyline" ADD COLUMN "coverImageId" INTEGER;
ALTER TABLE "Storyline" ADD COLUMN "heroImageId" INTEGER;
ALTER TABLE "Storyline" ADD COLUMN "heroImagePosition" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "Storyline" ADD CONSTRAINT "Storyline_heroImagePosition_check"
  CHECK ("heroImagePosition" BETWEEN 0 AND 100);

CREATE INDEX "Storyline_coverImageId_idx" ON "Storyline"("coverImageId");
CREATE INDEX "Storyline_heroImageId_idx" ON "Storyline"("heroImageId");

ALTER TABLE "Storyline" ADD CONSTRAINT "Storyline_coverImageId_fkey"
  FOREIGN KEY ("coverImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Storyline" ADD CONSTRAINT "Storyline_heroImageId_fkey"
  FOREIGN KEY ("heroImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

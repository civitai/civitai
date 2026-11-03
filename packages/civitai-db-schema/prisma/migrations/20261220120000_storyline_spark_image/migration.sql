-- Storylines: the image a storyline was started from (its spark), credited above chapter 1.
--
-- MANUAL APPLY: a human applies this per environment, BEFORE the code that reads the column ships.
-- Additive: one nullable column, no table rewrite. The foreign key briefly locks "Image"; the lock
-- timeout makes a busy table fail fast so the statement can be retried.
SET lock_timeout = '3s';

ALTER TABLE "Storyline" ADD COLUMN "sparkImageId" INTEGER;

CREATE INDEX "Storyline_sparkImageId_idx" ON "Storyline"("sparkImageId");

ALTER TABLE "Storyline" ADD CONSTRAINT "Storyline_sparkImageId_fkey"
  FOREIGN KEY ("sparkImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

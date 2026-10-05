-- Idempotent: applied by hand, possibly more than once.
--
-- 🔴 APPLY BEFORE THE CODE DEPLOYS: the new build selects both columns on every crucible read.
-- The reverse order is safe — existing rows default to yellow and the old build reads neither.

ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "buzzType" TEXT NOT NULL DEFAULT 'yellow';
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "heroImageId" INTEGER;

DO $$ BEGIN
  ALTER TABLE "Crucible" ADD CONSTRAINT "Crucible_heroImageId_fkey" FOREIGN KEY ("heroImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Crucible" ADD CONSTRAINT "Crucible_buzzType_check" CHECK ("buzzType" IN ('yellow', 'green'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

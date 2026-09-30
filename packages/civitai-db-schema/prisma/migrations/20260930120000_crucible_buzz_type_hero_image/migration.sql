-- Crucible: the Buzz currency a crucible runs on (from the domain it was created on, like
-- challenges) and an optional hero background separate from the card cover.
--
-- Idempotent, like 20260914120000_crucible: these environments are updated by hand.
--
-- 🔴 APPLY THIS BEFORE THE CODE DEPLOYS. Both columns join the crucible selects, so the new build
-- SELECTs them on every crucible read; without them every crucible page errors. The reverse order
-- is safe: existing rows default to yellow and nothing reads either column until the deploy lands.

ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "buzzType" TEXT NOT NULL DEFAULT 'yellow';
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "heroImageId" INTEGER;

DO $$ BEGIN
  ALTER TABLE "Crucible" ADD CONSTRAINT "Crucible_heroImageId_fkey" FOREIGN KEY ("heroImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Crucible" ADD CONSTRAINT "Crucible_buzzType_check" CHECK ("buzzType" IN ('yellow', 'green'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

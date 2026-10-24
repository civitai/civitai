-- Idempotent: applied by hand, possibly more than once.
--
-- 🔴 APPLY BEFORE THE CODE DEPLOYS: the new build selects the column on every crucible read.
-- The reverse order is safe — existing rows default to 0 and the old build doesn't read it.

ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "freeEntriesPerUser" INTEGER NOT NULL DEFAULT 0;

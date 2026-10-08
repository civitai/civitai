-- Idempotent: applied by hand, possibly more than once.
--
-- 🔴 APPLY BEFORE THE CODE DEPLOYS: the new build selects both columns on every crucible read.
-- The reverse order is safe: the old build doesn't read them.
--
-- The cutoff defaults to 0 here, not to the 10% new crucibles get: the new build always writes it,
-- so the default only reaches rows that predate it or that the old build creates before the deploy,
-- and none of those should stop taking entries early.

ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "entryWarningPercent" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "entryCutoffPercent" INTEGER NOT NULL DEFAULT 0;

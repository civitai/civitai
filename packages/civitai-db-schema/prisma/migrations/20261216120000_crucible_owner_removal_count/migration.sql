-- Entries a crucible's owner has removed from it. The cap (10) is enforced in the removal's own
-- UPDATE; moderator removals never touch this column.
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "ownerRemovalCount" INTEGER NOT NULL DEFAULT 0;

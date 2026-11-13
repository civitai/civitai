-- Running and finished crucibles keep the old placement bar; ones that haven't started, and every new
-- row, get the time-adjusted one.
ALTER TABLE "Crucible" ADD COLUMN "timeAdjustedPlacement" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Crucible" ALTER COLUMN "timeAdjustedPlacement" SET DEFAULT true;
UPDATE "Crucible" SET "timeAdjustedPlacement" = true WHERE status = 'Pending';

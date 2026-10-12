-- Existing crucibles (including live ones) keep the old placement bar; new rows get the time-adjusted one.
ALTER TABLE "Crucible" ADD COLUMN "timeAdjustedPlacement" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Crucible" ALTER COLUMN "timeAdjustedPlacement" SET DEFAULT true;

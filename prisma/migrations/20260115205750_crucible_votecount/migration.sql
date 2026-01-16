-- Add voteCount column to CrucibleEntry table
ALTER TABLE "CrucibleEntry" ADD COLUMN IF NOT EXISTS "voteCount" INTEGER NOT NULL DEFAULT 0;

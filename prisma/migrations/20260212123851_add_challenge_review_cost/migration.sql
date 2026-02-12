-- Add reviewCost field to Challenge for paid judging feature
ALTER TABLE "Challenge" ADD COLUMN "reviewCost" INTEGER NOT NULL DEFAULT 0;

-- Storylines: the title's rating from the text scan, a moderator's override of it, and whether
-- the takedown flag was set by the scan (which may lift it) rather than by a moderator.
--
-- MANUAL APPLY: a human applies this per environment, after 20261024130000_storyline_cover_hero,
-- BEFORE the code that reads these columns ships. Additive: nullable columns and columns with
-- constant defaults (no table rewrite).
SET lock_timeout = '3s';

ALTER TABLE "Storyline" ADD COLUMN "nsfwLevel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Storyline" ADD COLUMN "moderatorNsfwLevel" INTEGER;
ALTER TABLE "Storyline" ADD COLUMN "tosViolationByScan" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Storyline" ADD COLUMN "scanFlagLiftedTextHash" TEXT;

ALTER TABLE "Storyline" ADD CONSTRAINT "Storyline_nsfwLevel_check"
  CHECK ("nsfwLevel" IN (0, 1, 2, 4, 8, 16));
ALTER TABLE "Storyline" ADD CONSTRAINT "Storyline_moderatorNsfwLevel_check"
  CHECK ("moderatorNsfwLevel" IS NULL OR "moderatorNsfwLevel" IN (1, 2, 4, 8, 16));

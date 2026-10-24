-- Storylines: the title scan's minor finding, held apart from a takedown.
--
-- A title the scan finds to be about a minor no longer takes the storyline down on its own (only
-- with an NSFW title). It sets this instead, and while it is set every chapter is held to safe
-- for work, whatever the owner's `maxNsfwLevel` says. Set and cleared only by the scan.
--
-- MANUAL APPLY: a human applies this per environment, after
-- 20261024150000_storyline_moderator_takedown, BEFORE the code that reads it ships. Additive: one
-- column with a constant default (no table rewrite). No backfill: a storyline the scan took down
-- for minor under the old rule stays down until its title is rescanned clean.
SET lock_timeout = '3s';

ALTER TABLE "Storyline" ADD COLUMN "minorByScan" BOOLEAN NOT NULL DEFAULT false;

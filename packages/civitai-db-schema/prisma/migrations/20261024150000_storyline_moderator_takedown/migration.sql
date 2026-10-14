-- Storylines: a moderator's takedown, held apart from the title scan's.
--
-- `tosViolation` stays the flag every read gates on; it is true while either the scan
-- (`tosViolationByScan`) or a moderator (this column) holds a takedown. With one shared flag, a
-- moderator's restore could clear a takedown the scan held, and a scan verdict arriving while a
-- moderator's takedown was in place had nowhere to be recorded.
--
-- MANUAL APPLY: a human applies this per environment, after
-- 20261024140000_storyline_title_moderation, BEFORE the code that reads it ships. Additive: one
-- column with a constant default (no table rewrite). No backfill: a takedown written by hand
-- before this, with neither flag set, stays down, and no scan or restore lifts it.
SET lock_timeout = '3s';

ALTER TABLE "Storyline" ADD COLUMN "tosViolationByModerator" BOOLEAN NOT NULL DEFAULT false;

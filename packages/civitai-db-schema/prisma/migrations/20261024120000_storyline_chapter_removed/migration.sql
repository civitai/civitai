-- Storylines: a chapter whose placement was removed is marked, not deleted. The row stays and
-- readers other than moderators see a removed tombstone.
--
-- MANUAL APPLY: a human applies this per environment, after 20261023140000_storyline_engagement,
-- BEFORE the code that reads the column ships. Purely additive: one nullable column, no default,
-- so no table rewrite.
SET lock_timeout = '3s';

ALTER TABLE "StorylineChapter" ADD COLUMN "removedAt" TIMESTAMP(3);

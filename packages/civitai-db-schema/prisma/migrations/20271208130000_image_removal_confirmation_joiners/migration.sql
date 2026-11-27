-- Moderators whose removal joined a pending held removal. They may not confirm it, as the requester
-- may not.
--
-- HAND-APPLIED. Apply BEFORE the release that writes it: the hold's insert sets this column on a join,
-- and confirming reads it. Code already deployed ignores the column; the default covers its inserts.
-- No backfill: a request already Pending when this applies has no record of who joined it.

ALTER TABLE "ImageRemovalConfirmation" ADD COLUMN IF NOT EXISTS "joinedByIds" INTEGER[] NOT NULL DEFAULT '{}';

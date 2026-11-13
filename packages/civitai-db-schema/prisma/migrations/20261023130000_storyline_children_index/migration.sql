-- Children of a storyline chapter are read oldest first; index the order so the read needs no
-- sort. Replaces the single-column index from 20261023120000_storylines.
--
-- MANUAL APPLY: a human applies this per environment after 20261023120000_storylines. Index
-- only; no table or data changes. The table is new, so the drop and create are quick.

DROP INDEX IF EXISTS "StorylineChapterEdge_parentChapterId_idx";

CREATE INDEX IF NOT EXISTS "StorylineChapterEdge_parentChapterId_createdAt_idx"
  ON "StorylineChapterEdge"("parentChapterId", "createdAt");

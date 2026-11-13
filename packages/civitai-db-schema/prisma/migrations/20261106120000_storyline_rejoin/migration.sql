-- Storylines: a chapter may have more than one parent, so two branches can rejoin at one chapter.
--
-- v1 held every chapter to one parent with a unique index on the edge's "chapterId". Dropping it is
-- the whole schema change: the primary key ("chapterId", "parentChapterId") still refuses the same
-- link twice and still serves lookups by "chapterId", so no read loses an index.
--
-- MANUAL APPLY, per environment. Either order against the deploy is safe: until this runs, linking
-- a second parent fails on the index and the server refuses it with a 400, and nothing else writes a
-- second parent. Re-runnable.
SET lock_timeout = '3s';

DROP INDEX IF EXISTS "StorylineChapterEdge_single_parent_key";

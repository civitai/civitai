-- Apply by hand, off-peak, before the deploy that ships the CommentV3 reader re-point: the comment
-- notification processors and the comment reaction milestone run every minute on a createdAt
-- cursor, and without these indexes each run scans its whole table. Applying early is harmless:
-- nothing before the re-point reads these tables by createdAt.
--
-- CONCURRENTLY cannot run inside a transaction, so run each statement on its own. A cancelled build
-- leaves an invalid index under its name, which IF NOT EXISTS then skips. After applying, check
-- pg_index.indisvalid; if false, DROP INDEX CONCURRENTLY and run the statement again.

CREATE INDEX CONCURRENTLY IF NOT EXISTS commentv3_created ON "CommentV3" ("createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "CommentV3Reaction_createdAt_idx"
  ON "CommentV3Reaction" ("createdAt");

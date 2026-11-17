-- Partial index for the model reviews page's text-only list (`writtenReviewSql`): a version's
-- written reviews, newest first, without walking every thumbs-only review of the version.
-- Not expressible in schema.full.prisma (Prisma has no partial indexes): it lives only here.
--
-- MANUAL APPLY, per environment. CONCURRENTLY cannot run inside a transaction, so run this ONE
-- statement on its own, outside BEGIN/COMMIT (the dry run in BEGIN; ... ROLLBACK; does not apply
-- to it). If it fails mid-build it leaves an INVALID index: run
-- `DROP INDEX CONCURRENTLY IF EXISTS "ResourceReview_modelVersionId_createdAt_written_idx"` and re-run.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ResourceReview_modelVersionId_createdAt_written_idx"
  ON "ResourceReview" ("modelVersionId", "createdAt" DESC)
  WHERE "details" IS NOT NULL AND "details" <> '';

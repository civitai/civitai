-- Clamp Article.publishedAt where prior republishes or mod-restores bumped
-- it past the original publish date. Companion to the anti-bump preservation
-- in updateArticle (Draft branch) and restoreArticleById (see commit notes /
-- ClickUp follow-up to 868jne3fd). One-shot data fix — the application code
-- now preserves publishedAt across unpublish->republish and mod restore.
--
-- NOTE: This file is for review/history only. Per the project migration
-- policy, this SQL is NOT applied automatically by `prisma migrate deploy`.
-- It must be applied manually to preview / staging / prod by a human.

BEGIN;

-- Clamp Article.publishedAt where we have evidence of an earlier publish
-- date: a stashed `metadata.unpublishedAt` (set by user unpublish or mod
-- action) that predates the current publishedAt. Use unpublishedAt as the
-- clamp target (best available evidence of the original publish window),
-- with createdAt as a defensive floor — publish can never precede creation.
--
-- Scope:
--   * Only Published rows with a past publishedAt (skip Scheduled if any).
--   * Only rows whose `metadata.unpublishedAt` actually predates publishedAt
--     — otherwise the metadata key is a stale artifact of a later unpublish
--     that didn't bump on republish (i.e. nothing to clamp).
UPDATE "Article"
SET "publishedAt" = GREATEST(
  "createdAt",
  LEAST(
    "publishedAt",
    COALESCE((metadata->>'unpublishedAt')::timestamptz, "publishedAt")
  )
)
WHERE status = 'Published'::"ArticleStatus"
  AND "publishedAt" IS NOT NULL
  AND "publishedAt" <= NOW()
  AND metadata->>'unpublishedAt' IS NOT NULL
  AND (metadata->>'unpublishedAt')::timestamptz < "publishedAt";

COMMIT;

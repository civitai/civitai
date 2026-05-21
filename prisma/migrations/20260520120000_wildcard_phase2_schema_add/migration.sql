-- Wildcard moderation pipeline cleanup, Phase 2 — schema add (step 1 of 6).
-- See docs/wildcard-moderation-pipeline-cleanup.md §Phase 2 for the full plan.
--
-- This migration is purely additive — no data changes, no column drops. The
-- new columns default to `false`, which is the correct pre-backfill state:
--
--   - `WildcardSet.usable` — true iff at least one Clean category exists.
--     Read paths use this to gate the model detail page's Generate button
--     without sub-querying categories. The backfill endpoint (added in step 2)
--     and the audit verdict path (rewired in step 5) populate it.
--
--   - `WildcardSetCategory.blocked` — denormalized mirror of
--     `EntityModeration.blocked` for hot-path filtering. Default `false`
--     matches current reality (zero Dirty rows in production as of this
--     migration; future Dirty verdicts will flip this alongside the EM
--     update).
--
-- Indexes added for the read paths that will switch to these columns in
-- step 4: a `WildcardSet.usable` lookup (picker filters by usable=true) and
-- a `(wildcardSetId, blocked)` compound index (category scans within a set).

ALTER TABLE "WildcardSet"
  ADD COLUMN "usable" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "WildcardSet_usable_idx" ON "WildcardSet"("usable");

ALTER TABLE "WildcardSetCategory"
  ADD COLUMN "blocked" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "WildcardSetCategory_wildcardSetId_blocked_idx"
  ON "WildcardSetCategory"("wildcardSetId", "blocked");

-- One-shot backfill for the new columns. Idempotent — running twice produces
-- the same result. Single statements (no joins beyond a sub-query EXISTS),
-- fast at current scale (~K sets, ~100K categories). Future writes are owned
-- by `recomputeWildcardSetAuditStatus` (set-level usable) and
-- `applyWildcardCategoryAuditSuccess` (per-category blocked).
--
-- After this migration, the canGenerate read path can filter on
-- `WildcardSet.usable = true` AND `isInvalidated = false` AND (sfwOnly ?
-- nsfw = false : true) without sub-querying categories.

-- WildcardSet.usable = true iff at least one Clean category exists.
UPDATE "WildcardSet" ws
SET "usable" = EXISTS (
  SELECT 1 FROM "WildcardSetCategory" wsc
  WHERE wsc."wildcardSetId" = ws.id
    AND wsc."auditStatus" = 'Clean'::"WildcardSetCategoryAuditStatus"
);

-- WildcardSetCategory.blocked = true iff the existing auditStatus is Dirty.
-- Today this matches zero rows (no Dirty categories in production) but ships
-- the contract so any future Dirty verdicts that pre-date the writer switch
-- (Phase 2 step 5) still land on the new column.
UPDATE "WildcardSetCategory"
SET "blocked" = true
WHERE "auditStatus" = 'Dirty'::"WildcardSetCategoryAuditStatus";

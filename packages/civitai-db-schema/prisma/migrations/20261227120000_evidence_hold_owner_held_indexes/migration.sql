-- Indexes for evidence_hold_owner_held(uid) (next migration), which the Image delete trigger runs
-- once per deleted row: each of its owner legs becomes an index lookup instead of a scan.
-- Apply BEFORE 20261227130000_evidence_hold_owner_held. CONCURRENTLY: run each statement on its
-- own, outside a transaction (so no BEGIN/ROLLBACK dry run).
-- IF NOT EXISTS also skips an INVALID index left by an interrupted build; after applying, check
-- pg_index.indisvalid for each, and if false, DROP INDEX CONCURRENTLY and run it again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CsamReport_userId_idx"
  ON "CsamReport" ("userId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "CsamReport_secondaryUserId_idx"
  ON "CsamReport" ((details ->> 'secondaryUserId'))
  WHERE details ->> 'secondaryUserId' IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Image_csam_review_userId_idx"
  ON "Image" ("userId")
  WHERE "needsReview" = 'csam';

-- Per-entity counts of open, hand-triaged reports (the moderator app's Reports sub-nav badges).
--
-- The only usable index on "Report" is (id) WHERE status = 'Pending', which the reason filter can't use,
-- so the counting query seq-scanned all ~2.4M rows (~300ms) to find the ~20k reports that matter. Leading
-- with "reason" and carrying "id" makes it an index-only scan; the predicate covers both open statuses so
-- reason sets can change in code without losing the index.
--
-- Run OUTSIDE a transaction (CONCURRENTLY cannot run inside one).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Report_open_reason_id_idx"
  ON "Report" ("reason", "id")
  WHERE "status" IN ('Pending'::"ReportStatus", 'Processing'::"ReportStatus");

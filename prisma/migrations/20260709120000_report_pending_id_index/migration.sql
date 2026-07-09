-- The moderator "Reported" image queue (apps/moderator /images/reported) scans "Report" by
-- status='Pending' oldest-first. "Report" has ~400k pending rows (of ~1.9M) and no status index, so the
-- query parallel-seq-scans + sorts (~600ms). This partial index on id (monotonic with creation time —
-- the queue orders by report.id ASC) lets it index-scan the pending backlog in order and stop at LIMIT.
--
-- Apply manually (we do NOT run prisma migrate deploy). CONCURRENTLY avoids a write lock on the hot
-- Report table; it cannot run inside a transaction, so run this statement on its own (not wrapped in a
-- migration transaction).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Report_pending_id_idx" ON "Report" (id) WHERE status = 'Pending';

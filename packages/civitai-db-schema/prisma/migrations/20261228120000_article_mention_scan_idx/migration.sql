-- Article @mention notifications (new-mention, src/server/notifications/mention.notifications.ts) look
-- for published articles touched since the processor's last run. Without this index every run is a
-- seq scan of "Article".
--
-- HAND-APPLIED. Additive; notifications are correct without it, only slow. The expression and the
-- predicate must match `articleMentionsSql` exactly, or the planner will not use it.
-- RUN OUTSIDE ANY TRANSACTION (CONCURRENTLY). A failed build leaves an INVALID index:
-- DROP INDEX IF EXISTS "Article_mention_scan_idx", then re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Article_mention_scan_idx"
  ON "Article" (GREATEST("publishedAt", "updatedAt", "contentScannedAt"))
  WHERE status = 'Published';

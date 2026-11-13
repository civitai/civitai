-- The control lane is a small slice of "ScanLabelItem"; without this index, serving from it and the
-- control sample job's counts scan the whole queue.
--
-- Apply any time: the code works without it, only slower. CONCURRENTLY cannot run inside a
-- transaction, so run this statement on its own.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ScanLabelItem_control_idx"
  ON "ScanLabelItem" ("status", "votes" DESC, "firstFlaggedAt" DESC)
  WHERE "lane" = 'control';

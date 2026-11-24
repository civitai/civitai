-- The generation queue's unlock looks up a comic panel by its workflowId before charging, so it can
-- send comic panels to the comic editor. Without this index each lookup scans ComicPanel.
-- CONCURRENTLY, so run it on its own, outside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ComicPanel_workflowId_idx"
  ON "ComicPanel" ("workflowId");

-- One Pending in-app appeal per (entityType, entityId, userId): the same rule as
-- "Appeal_entityType_entityId_userId_pending_key", narrowed to category IS NULL so that a form appeal
-- and an in-app appeal on the same entity do not block each other. The old key is dropped in
-- 20261102120400 once this one is valid; while both exist the old one is the stricter.
--
-- Apply after 20261102120000_appeal_category.
-- RUN OUTSIDE ANY TRANSACTION (CONCURRENTLY). A failed build leaves an INVALID index:
-- DROP INDEX IF EXISTS "Appeal_inapp_pending_key", then re-run.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Appeal_inapp_pending_key"
  ON "Appeal" ("entityType", "entityId", "userId")
  WHERE status = 'Pending' AND category IS NULL;

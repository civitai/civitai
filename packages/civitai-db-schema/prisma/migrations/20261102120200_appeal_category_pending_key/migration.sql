-- One Pending form appeal per (category, entityType, entityId, userId). An Account and an Other
-- appeal both point at the appellant's own User row, so the category has to be part of the key.
--
-- Apply after 20261102120100_appeal_inapp_pending_key.
-- RUN OUTSIDE ANY TRANSACTION (CONCURRENTLY). A failed build leaves an INVALID index:
-- DROP INDEX IF EXISTS "Appeal_category_pending_key", then re-run.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Appeal_category_pending_key"
  ON "Appeal" (category, "entityType", "entityId", "userId")
  WHERE status = 'Pending' AND category IS NOT NULL;

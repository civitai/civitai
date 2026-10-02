-- An image can be appealed again once it is re-blocked, so a user may hold several appeals on
-- one entity over time. Only one of them may be Pending at a time; Prisma cannot express a
-- partial unique index, so it lives only here.
-- Fail fast instead of queueing every Appeal query behind a lock held by a long transaction.
SET lock_timeout = '3s';
CREATE INDEX "Appeal_entityType_entityId_userId_idx" ON "Appeal"("entityType", "entityId", "userId");
CREATE UNIQUE INDEX "Appeal_entityType_entityId_userId_pending_key" ON "Appeal"("entityType", "entityId", "userId") WHERE status = 'Pending';
DROP INDEX "Appeal_entityType_entityId_userId_key";

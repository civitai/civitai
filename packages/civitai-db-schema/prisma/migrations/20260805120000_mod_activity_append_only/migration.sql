-- ModActivity becomes append-only.
--
-- The unique index collapsed repeats of the same (activity, entityType, entityId) into one row via
-- ON CONFLICT DO UPDATE, so the table recorded only the LAST actor per entity — no history. The
-- moderator tooling needs the full trail ("who did what, when"), so the constraint goes and the
-- writers switch to plain INSERTs.
--
-- Existing rows are already deduped; this cannot be backfilled. History accrues from here.
--
-- Run the CREATE INDEX statements OUTSIDE a transaction (CONCURRENTLY cannot run inside one).

-- DropIndex — the @@unique. Named as a plain unique index by Prisma, but drop the constraint form too
-- in case it was promoted to one in any environment.
ALTER TABLE "ModActivity" DROP CONSTRAINT IF EXISTS "ModActivity_activity_entityType_entityId_key";
DROP INDEX IF EXISTS "ModActivity_activity_entityType_entityId_key";

-- CreateIndex — "prior mod activity on this entity, newest first" (User Lookup, Reports, anti-overlap).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ModActivity_entityType_entityId_createdAt_idx"
  ON "ModActivity" ("entityType", "entityId", "createdAt");

-- CreateIndex — "what has this moderator been doing", and the anti-overlap check.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ModActivity_userId_createdAt_idx"
  ON "ModActivity" ("userId", "createdAt");

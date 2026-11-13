-- Text scan 03: server-owned moderation state on Bounty (the text-scan POI snapshot).
-- Additive and nullable. Apply BEFORE deploying: an unscoped Prisma bounty read selects every
-- scalar column, so a client that knows "meta" fails against a table without it.
SET lock_timeout = '3s';
ALTER TABLE "Bounty" ADD COLUMN IF NOT EXISTS "meta" JSONB;
RESET lock_timeout;

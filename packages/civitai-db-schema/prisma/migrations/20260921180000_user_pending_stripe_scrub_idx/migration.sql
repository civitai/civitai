-- The GDPR Stripe scrub job asks, every 10 minutes: which deleted accounts still point at a
-- Stripe customer? That is 51 rows today, out of 1.33M deleted users, and the only index that
-- fits is on "deletedAt" alone — so the scan walks every deleted row and discards almost all of
-- them. Measured on the replica over a 365-day range: 239,921 buffers and 467 ms to return 49
-- rows, growing with every deletion (about 435/day) and never converging, because a scrubbed row
-- leaves the result set but stays in the range.
--
-- This partial index holds only the rows the job can act on: 51 entries today, and it shrinks
-- again as each account is scrubbed and its pointer nulled.
--
-- SQL-only, and absent from schema.full.prisma, because Prisma cannot express a partial index.
-- That drift is deliberate: do not "fix" it by dropping the WHERE clause.
--
-- CONCURRENTLY, so it takes no write lock on "User". It cannot run inside a transaction block.
--
-- RECOVERY: an interrupted CONCURRENTLY build leaves the index behind as INVALID, and re-running
-- the statement below will NOT rebuild it — IF NOT EXISTS sees the name and does nothing, silently.
-- Check first, and drop before retrying:
--   SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
--    WHERE c.relname = 'User_pendingStripeScrub_idx';
--   DROP INDEX CONCURRENTLY IF EXISTS "User_pendingStripeScrub_idx";
--
-- Executed on dev 2026-09-21 as a validity check only (indisvalid = true). Dev is not prod-sized,
-- so nothing about dev's timing says anything about prod's.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_pendingStripeScrub_idx"
  ON "User" ("deletedAt")
  WHERE "customerId" IS NOT NULL AND "deletedAt" IS NOT NULL;

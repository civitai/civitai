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
-- CONCURRENTLY, so it takes no write lock on "User". It cannot run inside a transaction block;
-- if it is interrupted it leaves an INVALID index that must be dropped before retrying.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_pendingStripeScrub_idx"
  ON "User" ("deletedAt")
  WHERE "customerId" IS NOT NULL AND "deletedAt" IS NOT NULL;

-- A claim's opaque token: the Scan Labels page carries it instead of the item's id. Minted on insert
-- and kept when a reload refreshes the lease. A vote keeps the token it was cast with, so a repeat
-- from a second tab still finds its card.
--
-- Apply BEFORE the code that reads it. The column is nullable with a default, so code still running
-- without it keeps working. The volatile default rewrites "ScanLabelClaim", which holds only the
-- leases of the last few minutes plus unvoted ones, so the lock is brief.
ALTER TABLE "ScanLabelClaim" ADD COLUMN IF NOT EXISTS "token" uuid DEFAULT gen_random_uuid();
UPDATE "ScanLabelClaim" SET "token" = gen_random_uuid() WHERE "token" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ScanLabelClaim_token_key" ON "ScanLabelClaim" ("token");

-- Looked up together with "userId", which "ScanLabelVote_userId_createdAt_idx" already serves.
ALTER TABLE "ScanLabelVote" ADD COLUMN IF NOT EXISTS "claimToken" uuid;

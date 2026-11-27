-- Set when a moderator skips a Scan Labels card, or it is dropped from their queue because its media
-- cannot be served to them. The claim's item never comes back to that moderator; other moderators are
-- unaffected, and nothing is recorded against the item.
--
-- Apply BEFORE the code that reads it. Nullable with no default, so the ALTER is a catalog change only
-- and code still running without it keeps working.
ALTER TABLE "ScanLabelClaim" ADD COLUMN IF NOT EXISTS "releasedAt" timestamptz(3);

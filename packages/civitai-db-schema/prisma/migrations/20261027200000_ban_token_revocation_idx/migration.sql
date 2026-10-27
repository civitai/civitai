-- Indexes for revoking a banned or deleted account's API keys (`expireUserApiKeys`, run on every ban
-- and every 15 minutes by the `revoke-user-tokens` job over recent bans). Without them both reads are
-- seq scans: of "User" for recent bans, and of "ApiKey" by user.
--
-- MANUAL APPLY: the main DB does not auto-apply migrations. Apply per environment (dev, then prod).
-- Additive; the code is correct without them, only slow. Check first whether an equivalent "ApiKey"
-- ("userId") index already exists under another name.
--
-- RUN OUTSIDE ANY TRANSACTION (CONCURRENTLY), one statement at a time. A failed build leaves an
-- INVALID index: DROP INDEX IF EXISTS "<name>", then re-run that statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_bannedAt_idx"
  ON "User" ("bannedAt")
  WHERE "bannedAt" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ApiKey_userId_idx"
  ON "ApiKey" ("userId");

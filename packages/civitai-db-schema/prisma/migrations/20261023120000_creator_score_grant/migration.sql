-- Apply before the deploy that ships /api/mod/user/creator-score-grant: the endpoint writes here.
--
-- 🔴 The FKs to "User" take a SHARE ROW EXCLUSIVE lock on "User" while the table is created (blocks
-- writes, not reads). Apply one statement at a time and re-run on lock timeout.

CREATE TABLE IF NOT EXISTS "CreatorScoreGrant" (
  "id"           SERIAL PRIMARY KEY,
  "userId"       INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "amount"       INTEGER NOT NULL CHECK ("amount" > 0),
  "reason"       TEXT NOT NULL CHECK (length(btrim("reason")) > 0),
  -- SET NULL: erasing a moderator's account must not fail on the audit rows they wrote.
  "grantedById"  INTEGER REFERENCES "User"("id") ON DELETE SET NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"    TIMESTAMP(3),
  "revokedById"  INTEGER REFERENCES "User"("id") ON DELETE SET NULL,
  "revokeReason" TEXT
);

CREATE INDEX IF NOT EXISTS "CreatorScoreGrant_userId_createdAt_idx"
  ON "CreatorScoreGrant" ("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "CreatorScoreGrant_grantedById_createdAt_idx"
  ON "CreatorScoreGrant" ("grantedById", "createdAt");

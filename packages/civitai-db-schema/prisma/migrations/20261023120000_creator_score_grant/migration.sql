-- Creator Score a moderator awarded by hand, one row per grant. A revoke stamps the row; nothing is
-- deleted. `User.meta.scores.staffAwarded` is recomputed from the unrevoked rows on every grant and
-- revoke.
--
-- Apply before the deploy that ships /api/mod/user/creator-score-grant: the endpoint writes here, and
-- nothing else reads the table.
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
-- The per-moderator daily cap counts a moderator's grants in the last 24 hours.
CREATE INDEX IF NOT EXISTS "CreatorScoreGrant_grantedById_createdAt_idx"
  ON "CreatorScoreGrant" ("grantedById", "createdAt");

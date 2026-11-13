-- Upload scan label queue: moderators vote on images an upload scan flagged, three votes per image.
--
-- A flag is a label only; nothing here changes an image's visibility.
-- "ScanLabelFlag" rows attach to one "ScanLabelItem" per image, so votes are never split by a rescan.
--
-- Apply before the moderator page is granted to anyone and before anything writes flags.
--
-- 🔴 The FK to "Image" takes a SHARE ROW EXCLUSIVE lock on "Image" while the table is created (blocks
-- writes, not reads). Apply one statement at a time and re-run on lock timeout.

CREATE TABLE IF NOT EXISTS "ScanLabelItem" (
  "id"             SERIAL PRIMARY KEY,
  "imageId"        INTEGER NOT NULL REFERENCES "Image"("id") ON DELETE CASCADE,
  "lane"           TEXT NOT NULL DEFAULT 'flagged' CHECK ("lane" IN ('flagged', 'control')),
  "firstFlaggedAt" TIMESTAMPTZ(3) NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'decided', 'void')),
  "voidReason"     TEXT,
  "votes"          SMALLINT NOT NULL DEFAULT 0 CHECK ("votes" BETWEEN 0 AND 3),
  "blockVotes"     SMALLINT NOT NULL DEFAULT 0 CHECK ("blockVotes" BETWEEN 0 AND "votes"),
  "outcome"        TEXT CHECK ("outcome" IN ('block', 'clear')),
  "unanimous"      BOOLEAN,
  "decidedAt"      TIMESTAMPTZ(3),
  "actionedAt"     TIMESTAMPTZ(3),
  "actionError"    TEXT,
  "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "ScanLabelItem_imageId_key" ON "ScanLabelItem" ("imageId");
CREATE INDEX IF NOT EXISTS "ScanLabelItem_queue_idx"
  ON "ScanLabelItem" ("status", "votes" DESC, "firstFlaggedAt" DESC);

CREATE TABLE IF NOT EXISTS "ScanLabelFlag" (
  "id"             SERIAL PRIMARY KEY,
  "itemId"         INTEGER NOT NULL REFERENCES "ScanLabelItem"("id") ON DELETE CASCADE,
  "source"         TEXT NOT NULL CHECK ("source" IN ('orchestrator-scan', 'xguard-prompt', 'control-sample')),
  "flaggerVersion" TEXT NOT NULL,
  "reason"         TEXT,
  "workflowId"     TEXT NOT NULL,
  "flaggedAt"      TIMESTAMPTZ(3) NOT NULL,
  "snapshot"       JSONB,
  "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "ScanLabelFlag_workflowId_key" ON "ScanLabelFlag" ("workflowId");
CREATE INDEX IF NOT EXISTS "ScanLabelFlag_itemId_idx" ON "ScanLabelFlag" ("itemId");
CREATE INDEX IF NOT EXISTS "ScanLabelFlag_flaggerVersion_idx" ON "ScanLabelFlag" ("flaggerVersion", "itemId");

-- "userId" has no FK: deleting a moderator's account must not silently remove votes that decided items.
CREATE TABLE IF NOT EXISTS "ScanLabelVote" (
  "itemId"    INTEGER NOT NULL REFERENCES "ScanLabelItem"("id") ON DELETE CASCADE,
  "userId"    INTEGER NOT NULL,
  "block"     BOOLEAN NOT NULL,
  "reason"    TEXT,
  "msOnItem"  INTEGER,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("itemId", "userId")
);

CREATE INDEX IF NOT EXISTS "ScanLabelVote_userId_createdAt_idx" ON "ScanLabelVote" ("userId", "createdAt");

-- Expiry is read lazily (`expiresAt > now`); nothing sweeps expired rows.
CREATE TABLE IF NOT EXISTS "ScanLabelClaim" (
  "itemId"    INTEGER NOT NULL REFERENCES "ScanLabelItem"("id") ON DELETE CASCADE,
  "userId"    INTEGER NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY ("itemId", "userId")
);

CREATE INDEX IF NOT EXISTS "ScanLabelClaim_userId_idx" ON "ScanLabelClaim" ("userId");

-- 50 is the floor, not only the default (`DEFAULT_DAILY_QUOTA` mirrors it).
CREATE TABLE IF NOT EXISTS "ScanLabelQuota" (
  "userId"     INTEGER PRIMARY KEY,
  "dailyVotes" INTEGER NOT NULL DEFAULT 50 CHECK ("dailyVotes" >= 50),
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "updatedBy"  INTEGER,
  "updatedAt"  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

-- Idempotent: applied by hand, possibly more than once.
-- The in-game inquisitor queue: a review per settled rating item, and the moderators' votes on it.
-- Additive (two new tables). Apply BEFORE deploying the Knights app build that writes them.
-- Apply after 20261210120000_knights_v2_tables.

CREATE TABLE IF NOT EXISTS "KnightsInquisitorReview" (
  "id" SERIAL PRIMARY KEY,
  "queueItemId" INTEGER NOT NULL REFERENCES "KnightsQueueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "imageId" INTEGER NOT NULL,
  "questionKey" TEXT NOT NULL,
  "consensusValue" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "confirmedValue" TEXT,
  "claimedBy" INTEGER,
  "claimExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3)
);

-- Added after the first copy of this file; both statements are safe to re-run and upgrade a database that applied it.
ALTER TABLE "KnightsInquisitorReview" ADD COLUMN IF NOT EXISTS "checkedAt" TIMESTAMP(3);
ALTER TABLE "KnightsInquisitorReview" DROP CONSTRAINT IF EXISTS "KnightsInquisitorReview_status_check";
ALTER TABLE "KnightsInquisitorReview" ADD CONSTRAINT "KnightsInquisitorReview_status_check"
  CHECK ("status" IN ('open', 'confirmed', 'split', 'excluded', 'expired'));

CREATE UNIQUE INDEX IF NOT EXISTS "KnightsInquisitorReview_queueItemId_key" ON "KnightsInquisitorReview" ("queueItemId");
CREATE INDEX IF NOT EXISTS "KnightsInquisitorReview_status_createdAt_idx" ON "KnightsInquisitorReview" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "KnightsInquisitorReview_imageId_idx" ON "KnightsInquisitorReview" ("imageId");
CREATE INDEX IF NOT EXISTS "KnightsInquisitorReview_status_checkedAt_idx" ON "KnightsInquisitorReview" ("status", "checkedAt");

CREATE TABLE IF NOT EXISTS "KnightsInquisitorVote" (
  "reviewId" INTEGER NOT NULL REFERENCES "KnightsInquisitorReview"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "moderatorId" INTEGER NOT NULL,
  "answer" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("reviewId", "moderatorId")
);

CREATE INDEX IF NOT EXISTS "KnightsInquisitorVote_moderatorId_createdAt_idx" ON "KnightsInquisitorVote" ("moderatorId", "createdAt");

-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights app build that serves hidden checks and issues smites.
CREATE TABLE IF NOT EXISTS "KnightsHiddenCheckAnswer" (
  "id" SERIAL PRIMARY KEY,
  "playerId" INTEGER NOT NULL,
  "referenceId" INTEGER NOT NULL REFERENCES "KnightsReferenceImage"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "imageId" INTEGER NOT NULL,
  "answer" TEXT NOT NULL,
  "correct" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "KnightsHiddenCheckAnswer_playerId_referenceId_key" ON "KnightsHiddenCheckAnswer" ("playerId", "referenceId");
CREATE INDEX IF NOT EXISTS "KnightsHiddenCheckAnswer_playerId_createdAt_idx" ON "KnightsHiddenCheckAnswer" ("playerId", "createdAt");
CREATE INDEX IF NOT EXISTS "KnightsHiddenCheckAnswer_playerId_imageId_idx" ON "KnightsHiddenCheckAnswer" ("playerId", "imageId");

ALTER TABLE "KnightsPlayer" ADD COLUMN IF NOT EXISTS "resetNoticeSeenAt" TIMESTAMP(3);

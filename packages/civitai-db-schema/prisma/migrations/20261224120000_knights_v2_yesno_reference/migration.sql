-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the moderator app build that manages yes/no reference pairs.
-- Depends on 20261210120000_knights_v2_queue (KnightsQuestion).
CREATE TABLE IF NOT EXISTS "KnightsYesNoReference" (
  "id" SERIAL PRIMARY KEY,
  "imageId" INTEGER NOT NULL REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "questionKey" TEXT NOT NULL REFERENCES "KnightsQuestion"("key") ON DELETE CASCADE ON UPDATE CASCADE,
  "answer" BOOLEAN NOT NULL,
  "explanation" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One known answer per image and question.
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsYesNoReference_imageId_questionKey_key"
  ON "KnightsYesNoReference" ("imageId", "questionKey");
-- Serving and listing the active pairs of a question.
CREATE INDEX IF NOT EXISTS "KnightsYesNoReference_active_questionKey_idx"
  ON "KnightsYesNoReference" ("active", "questionKey");

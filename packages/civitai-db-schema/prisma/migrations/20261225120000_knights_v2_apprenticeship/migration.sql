-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights app build that replaces the Trial with the Acolyte apprenticeship.
-- Depends on 20261212120000_knights_v2_trials (KnightsReferenceImage) and 20261224120000_knights_v2_yesno_reference (KnightsYesNoReference).
CREATE TABLE IF NOT EXISTS "KnightsApprenticeAnswer" (
  "id" SERIAL PRIMARY KEY,
  "playerId" INTEGER NOT NULL,
  "referenceId" INTEGER REFERENCES "KnightsReferenceImage"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "yesNoReferenceId" INTEGER REFERENCES "KnightsYesNoReference"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "answer" TEXT NOT NULL,
  "correctAnswer" TEXT NOT NULL,
  "correct" BOOLEAN NOT NULL,
  "xp" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "checkpointSeenAt" TIMESTAMP(3),
  -- Each answer belongs to exactly one kind of reference.
  CONSTRAINT "KnightsApprenticeAnswer_one_reference"
    CHECK (("referenceId" IS NULL) <> ("yesNoReferenceId" IS NULL))
);

-- Not expressible in Prisma: a player answers each reference at most once.
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsApprenticeAnswer_player_reference_key"
  ON "KnightsApprenticeAnswer" ("playerId", "referenceId") WHERE "referenceId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsApprenticeAnswer_player_yesno_key"
  ON "KnightsApprenticeAnswer" ("playerId", "yesNoReferenceId") WHERE "yesNoReferenceId" IS NOT NULL;
-- A player's latest answers, newest first.
CREATE INDEX IF NOT EXISTS "KnightsApprenticeAnswer_playerId_id_idx"
  ON "KnightsApprenticeAnswer" ("playerId", "id");
-- Deleting a reference cascades to its answers.
CREATE INDEX IF NOT EXISTS "KnightsApprenticeAnswer_referenceId_idx"
  ON "KnightsApprenticeAnswer" ("referenceId") WHERE "referenceId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "KnightsApprenticeAnswer_yesNoReferenceId_idx"
  ON "KnightsApprenticeAnswer" ("yesNoReferenceId") WHERE "yesNoReferenceId" IS NOT NULL;

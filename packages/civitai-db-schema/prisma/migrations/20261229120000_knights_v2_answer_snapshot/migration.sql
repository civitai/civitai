-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights and moderator app builds that read the snapshot (after 20261225120000_knights_v2_apprenticeship).
-- Answers outlive their reference: `imageId` + `questionKey` identify the answer once its reference foreign keys go NULL (ON DELETE SET NULL).
ALTER TABLE "KnightsApprenticeAnswer" ADD COLUMN IF NOT EXISTS "imageId" INTEGER;
ALTER TABLE "KnightsApprenticeAnswer" ADD COLUMN IF NOT EXISTS "questionKey" TEXT;

UPDATE "KnightsApprenticeAnswer" a
SET "imageId" = r."imageId", "questionKey" = r."questionKey"
FROM "KnightsReferenceImage" r
WHERE a."referenceId" = r."id" AND (a."imageId" IS NULL OR a."questionKey" IS NULL);

UPDATE "KnightsApprenticeAnswer" a
SET "imageId" = y."imageId", "questionKey" = y."questionKey"
FROM "KnightsYesNoReference" y
WHERE a."yesNoReferenceId" = y."id" AND (a."imageId" IS NULL OR a."questionKey" IS NULL);

ALTER TABLE "KnightsApprenticeAnswer" DROP CONSTRAINT IF EXISTS "KnightsApprenticeAnswer_referenceId_fkey";
ALTER TABLE "KnightsApprenticeAnswer" ADD CONSTRAINT "KnightsApprenticeAnswer_referenceId_fkey"
  FOREIGN KEY ("referenceId") REFERENCES "KnightsReferenceImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnightsApprenticeAnswer" DROP CONSTRAINT IF EXISTS "KnightsApprenticeAnswer_yesNoReferenceId_fkey";
ALTER TABLE "KnightsApprenticeAnswer" ADD CONSTRAINT "KnightsApprenticeAnswer_yesNoReferenceId_fkey"
  FOREIGN KEY ("yesNoReferenceId") REFERENCES "KnightsYesNoReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A live row names exactly one reference; once that is deleted both go NULL and the snapshot is what identifies the answer.
ALTER TABLE "KnightsApprenticeAnswer" DROP CONSTRAINT IF EXISTS "KnightsApprenticeAnswer_one_reference";
ALTER TABLE "KnightsApprenticeAnswer" ADD CONSTRAINT "KnightsApprenticeAnswer_one_reference"
  CHECK (
    ("referenceId" IS NULL) <> ("yesNoReferenceId" IS NULL)
    OR ("imageId" IS NOT NULL AND "questionKey" IS NOT NULL AND "referenceId" IS NULL AND "yesNoReferenceId" IS NULL)
  );

-- Prisma can't express this partial unique index. It is the no-repeat rule and must survive a deleted and re-added reference.
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsApprenticeAnswer_player_image_question_key"
  ON "KnightsApprenticeAnswer" ("playerId", "imageId", "questionKey") WHERE "imageId" IS NOT NULL;

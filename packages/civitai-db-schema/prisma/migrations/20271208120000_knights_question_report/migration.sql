-- Idempotent: applied by hand, possibly more than once.
-- "KnightsQuestionReport": one row per player who reported a yes/no queue question, with the reason they picked. The
-- question key and image are a snapshot. Only "counted" rows count toward pulling the question (a held or reset-pending
-- player's report does not). A moderator's keep or remove, or the import withdrawing the question, sets "resolvedAt".
-- "KnightsImagePull": an image taken out of every Knights yes/no question and Acolyte pair, at most one open row per
-- image, until a moderator keeps the question that caused it ("itemId") or returns the image. "reportId" is the
-- main-app Report filed for it; "filing" is 'pending' until it is 'filed', or 'not-needed' when the main app no longer
-- has the image; "attempts" and "lastAttemptAt" pace the tick's retries.
-- Order: apply this, then, in the same window (an infra owner, through the grant matrix):
--   the Knights app's role: SELECT, INSERT on both tables; UPDATE ("resolvedAt") on "KnightsQuestionReport";
--   UPDATE ("reportId", "filing", "attempts", "lastAttemptAt") on "KnightsImagePull"; USAGE on
--   "KnightsQuestionReport_id_seq" and "KnightsImagePull_id_seq";
--   the moderator app's role: SELECT and UPDATE ("resolvedAt", "resolvedBy") on both tables;
-- then deploy Knights and the moderator app. Knights' /play reads both tables: deploying it first breaks serving.
CREATE TABLE IF NOT EXISTS "KnightsQuestionReport" (
  "id" BIGSERIAL PRIMARY KEY,
  "playerId" INTEGER NOT NULL,
  "itemId" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "questionKey" TEXT NOT NULL,
  "imageId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" INTEGER,
  "counted" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "KnightsQuestionReport_reason_check" CHECK ("reason" IN ('image', 'question'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsQuestionReport_playerId_itemId_key" ON "KnightsQuestionReport" ("playerId", "itemId");
CREATE INDEX IF NOT EXISTS "KnightsQuestionReport_itemId_idx" ON "KnightsQuestionReport" ("itemId");

CREATE TABLE IF NOT EXISTS "KnightsImagePull" (
  "id" SERIAL PRIMARY KEY,
  "imageId" INTEGER NOT NULL,
  "itemId" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "reportId" INTEGER,
  "filing" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" INTEGER,
  CONSTRAINT "KnightsImagePull_filing_check" CHECK ("filing" IN ('pending', 'filed', 'not-needed'))
);
CREATE INDEX IF NOT EXISTS "KnightsImagePull_imageId_idx" ON "KnightsImagePull" ("imageId");
CREATE INDEX IF NOT EXISTS "KnightsImagePull_itemId_idx" ON "KnightsImagePull" ("itemId");
-- One open pull per image: a second pull of the same image adds nothing.
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsImagePull_open_imageId_key" ON "KnightsImagePull" ("imageId") WHERE "resolvedAt" IS NULL;

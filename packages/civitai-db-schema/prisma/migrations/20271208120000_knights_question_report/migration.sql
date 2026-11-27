-- Idempotent: applied by hand, possibly more than once.
-- "KnightsQuestionReport": one row per player who reported a yes/no queue question, with the reason they picked. The
-- question key and image are a snapshot. A moderator's keep or remove sets "resolvedAt" and "resolvedBy".
-- "KnightsImagePull": an image taken out of every Knights yes/no question and Acolyte pair, at most one open row per
-- image, until a moderator keeps it. "reportId" is the main-app Report filed for it, null until the filing succeeds.
-- Order: apply this, then, in the same window (an infra owner, through the grant matrix):
--   the Knights app's role: SELECT, INSERT on both tables; UPDATE ("reportId") on "KnightsImagePull"; USAGE on
--   "KnightsQuestionReport_id_seq" and "KnightsImagePull_id_seq";
--   the moderator app's role: SELECT and UPDATE ("resolvedAt", "resolvedBy") on both tables;
-- then deploy Knights and the moderator app.
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
  CONSTRAINT "KnightsQuestionReport_reason_check" CHECK ("reason" IN ('image', 'question'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsQuestionReport_playerId_itemId_key" ON "KnightsQuestionReport" ("playerId", "itemId");
CREATE INDEX IF NOT EXISTS "KnightsQuestionReport_itemId_idx" ON "KnightsQuestionReport" ("itemId");

CREATE TABLE IF NOT EXISTS "KnightsImagePull" (
  "id" SERIAL PRIMARY KEY,
  "imageId" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "reportId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" INTEGER
);
CREATE INDEX IF NOT EXISTS "KnightsImagePull_imageId_idx" ON "KnightsImagePull" ("imageId");
-- One open pull per image: a second pull of the same image adds nothing.
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsImagePull_open_imageId_key" ON "KnightsImagePull" ("imageId") WHERE "resolvedAt" IS NULL;

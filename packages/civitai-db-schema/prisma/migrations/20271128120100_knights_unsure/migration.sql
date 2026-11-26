-- Idempotent: applied by hand, possibly more than once.
-- One row per "Not sure" a player gives on a yes/no question, so the questions players find confusing can be counted per
-- question. Never a vote: nothing is paid, graded or decided from it. The question key and image are a snapshot, so a
-- count outlives the item. Kept in Postgres rather than ClickHouse because the game reads it back: an Acolyte practice
-- pair answered "Not sure" is not dealt again.
-- Order: apply this, grant the Knights app's database role SELECT and INSERT on "KnightsUnsure" and USAGE on
-- "KnightsUnsure_id_seq" (in the same window, through the grant setup the infra owners run), then deploy Knights. The skip
-- action writes here; without the grant the write fails, is logged and the skip still goes through.
CREATE TABLE IF NOT EXISTS "KnightsUnsure" (
  "id" BIGSERIAL PRIMARY KEY,
  "playerId" INTEGER NOT NULL,
  "itemId" INTEGER,
  "yesNoReferenceId" INTEGER,
  "questionKey" TEXT NOT NULL,
  "imageId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnightsUnsure_one_target" CHECK (("itemId" IS NULL) <> ("yesNoReferenceId" IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsUnsure_playerId_itemId_key" ON "KnightsUnsure" ("playerId", "itemId");
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsUnsure_playerId_yesNoReferenceId_key" ON "KnightsUnsure" ("playerId", "yesNoReferenceId");
CREATE INDEX IF NOT EXISTS "KnightsUnsure_itemId_idx" ON "KnightsUnsure" ("itemId");
CREATE INDEX IF NOT EXISTS "KnightsUnsure_yesNoReferenceId_idx" ON "KnightsUnsure" ("yesNoReferenceId");

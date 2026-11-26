-- Idempotent: applied by hand, possibly more than once.
-- Days a player voted in the original Knights game, so they count toward Paladin's days-played bar alongside
-- "KnightsPlayerDay". Filled once from the original game's vote history after this is applied; nothing writes it after.
-- Order: apply this, grant the Knights app's database role SELECT on the table, then deploy Knights. Knights reads it when
-- it counts days played (status pages and rank-ups), and those reads fail without the grant.
CREATE TABLE IF NOT EXISTS "KnightsLegacyPlayerDay" (
  "playerId" INTEGER NOT NULL,
  "day" DATE NOT NULL,
  CONSTRAINT "KnightsLegacyPlayerDay_pkey" PRIMARY KEY ("playerId", "day")
);

-- Idempotent: applied by hand, possibly more than once.
--
-- Civitai Games (Game Frame) reports in the moderator report queue. New tables plus one new system
-- user, so applying it ahead of or behind the deploy is harmless: the internal endpoint answers 503
-- until GAMES_GUEST_USER_ID is set, and Game Frame holds reports in its outbox until then.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "GameFrameGame" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "userId" INTEGER,
    "official" BOOLEAN NOT NULL DEFAULT false,
    "visibility" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "coverUrl" TEXT,
    "stateAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameFrameGame_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GameFrameGame_slug_key" ON "GameFrameGame"("slug");
CREATE INDEX IF NOT EXISTS "GameFrameGame_userId_idx" ON "GameFrameGame"("userId");

CREATE TABLE IF NOT EXISTS "GameFrameGameReport" (
    "gameFrameGameId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,

    CONSTRAINT "GameFrameGameReport_pkey" PRIMARY KEY ("reportId","gameFrameGameId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GameFrameGameReport_reportId_key" ON "GameFrameGameReport"("reportId");
CREATE INDEX IF NOT EXISTS "GameFrameGameReport_gameFrameGameId_idx" ON "GameFrameGameReport" USING HASH ("gameFrameGameId");

CREATE TABLE IF NOT EXISTS "GameFrameReportReceipt" (
    "gfReportId" TEXT NOT NULL,
    "reportId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameFrameReportReceipt_pkey" PRIMARY KEY ("gfReportId")
);

CREATE INDEX IF NOT EXISTS "GameFrameReportReceipt_reportId_idx" ON "GameFrameReportReceipt"("reportId");

DO $$ BEGIN
  ALTER TABLE "GameFrameGame" ADD CONSTRAINT "GameFrameGame_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "GameFrameGameReport" ADD CONSTRAINT "GameFrameGameReport_gameFrameGameId_fkey" FOREIGN KEY ("gameFrameGameId") REFERENCES "GameFrameGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "GameFrameGameReport" ADD CONSTRAINT "GameFrameGameReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "GameFrameReportReceipt" ADD CONSTRAINT "GameFrameReportReceipt_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The filer for reports from signed-out Game Frame players. It has no email and no linked account,
-- so nobody can sign in as it, and 'Ineligible' is what both reporter-reward paths read to pay 0.
INSERT INTO "User" ("username", "rewardsEligibility", "excludeFromLeaderboards")
VALUES ('civitai-games-guest', 'Ineligible', true)
ON CONFLICT ("username") DO NOTHING;

COMMIT;

-- After applying: set GAMES_GUEST_USER_ID on the main app to the id this prints.
SELECT "id", "username", "rewardsEligibility" FROM "User" WHERE "username" = 'civitai-games-guest';

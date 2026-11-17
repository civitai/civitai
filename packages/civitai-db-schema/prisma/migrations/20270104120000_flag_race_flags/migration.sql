-- Flag Race flag days and the hats spent on flags. Additive: two new empty tables.
CREATE TABLE "FlagDay" (
  "id" SERIAL NOT NULL,
  "event" TEXT NOT NULL,
  "crucibleId" INTEGER NOT NULL,
  "startsAt" TIMESTAMPTZ(3) NOT NULL,
  "cutAt" TIMESTAMPTZ(3) NOT NULL,
  "closesAt" TIMESTAMPTZ(3) NOT NULL,
  "imageIds" INTEGER[],
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FlagDay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FlagDay_event_crucibleId_key" ON "FlagDay"("event", "crucibleId");
CREATE INDEX "FlagDay_event_startsAt_idx" ON "FlagDay"("event", "startsAt");

CREATE TABLE "EventTurfFlagSticker" (
  "id" BIGSERIAL NOT NULL,
  "event" TEXT NOT NULL,
  "flagDayId" INTEGER NOT NULL,
  "imageId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "team" TEXT NOT NULL,
  "cosmeticId" INTEGER NOT NULL,
  "count" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventTurfFlagSticker_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EventTurfFlagSticker_flagDayId_imageId_team_userId_createdAt_idx" ON "EventTurfFlagSticker"("flagDayId", "imageId", "team", "userId", "createdAt");

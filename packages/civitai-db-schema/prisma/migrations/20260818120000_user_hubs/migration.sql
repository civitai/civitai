-- User-composed image feeds ("hubs"). Applied manually — see CLAUDE.md.

CREATE TYPE "UserHubSourceType" AS ENUM ('User', 'Model', 'ModelVersion', 'Collection');

CREATE TABLE "UserHub" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "index" INTEGER NOT NULL DEFAULT 0,
    "sort" TEXT NOT NULL DEFAULT 'Newest',
    "period" "MetricTimeframe" NOT NULL DEFAULT 'AllTime',
    "mediaTypes" "MediaType"[],
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "UserHub_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserHubSource" (
    "id" SERIAL NOT NULL,
    "hubId" INTEGER NOT NULL,
    "type" "UserHubSourceType" NOT NULL,
    "targetId" INTEGER NOT NULL,
    "alias" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "index" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UserHubSource_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserHub_userId_idx" ON "UserHub"("userId");
CREATE INDEX "UserHubSource_hubId_idx" ON "UserHubSource"("hubId");
CREATE UNIQUE INDEX "UserHubSource_hubId_type_targetId_key"
    ON "UserHubSource"("hubId", "type", "targetId");
-- Both indexes above lead with "hubId". `deleteCollectionById` deletes hub sources
-- by ("type", "targetId") with no hub, which neither can serve.
CREATE INDEX "UserHubSource_type_targetId_idx" ON "UserHubSource"("type", "targetId");

ALTER TABLE "UserHub" ADD CONSTRAINT "UserHub_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserHubSource" ADD CONSTRAINT "UserHubSource_hubId_fkey"
    FOREIGN KEY ("hubId") REFERENCES "UserHub"("id") ON DELETE CASCADE ON UPDATE CASCADE;

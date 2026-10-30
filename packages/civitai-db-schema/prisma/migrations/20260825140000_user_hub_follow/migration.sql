-- Following a hub. A new table only, so nothing existing is touched and there is no
-- backfill: every hub starts with no followers.
CREATE TABLE "UserHubFollow" (
    "userId" INTEGER NOT NULL,
    "hubId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Also the read path's index: the followed-hubs list is `WHERE "userId" = $1`, which
-- this serves on its leading column.
CREATE UNIQUE INDEX "UserHubFollow_userId_hubId_key" ON "UserHubFollow"("userId", "hubId");

-- For the hub side of the cascade, which has no other index to find its rows by.
CREATE INDEX "UserHubFollow_hubId_idx" ON "UserHubFollow"("hubId");

ALTER TABLE "UserHubFollow" ADD CONSTRAINT "UserHubFollow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserHubFollow" ADD CONSTRAINT "UserHubFollow_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "UserHub"("id") ON DELETE CASCADE ON UPDATE CASCADE;

----------------------------------
-- Add Notification Viewed
----------------------------------
CREATE TABLE "NotificationViewed" (
    id TEXT NOT NULL,
    "userId" INT,
    CONSTRAINT "NotificationViewed_pkey" PRIMARY KEY (id)
);
CREATE INDEX "NotificationViewed_userId" ON "NotificationViewed"("userId");

----------------------------------
-- Insert viewed notifications
----------------------------------
INSERT INTO "NotificationViewed"(id, "userId")
SELECT id, "userId" FROM "Notification" WHERE "viewedAt" IS NOT NULL;

----------------------------------
-- Clean up old table
----------------------------------
ALTER TABLE "Notification" DROP COLUMN "viewedAt";

/*
  Warnings:

  - A unique constraint covering the columns `[userId,type]` on the table `UserNotificationSettings` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "UserNotificationSettings_userId_type_key" ON "UserNotificationSettings"("userId", "type");

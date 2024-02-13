-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('Comment', 'Update', 'Milestone', 'Bounty', 'Other');

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "category" "NotificationCategory" NOT NULL DEFAULT 'Other';

-- CreateEnum
CREATE TYPE "HomeBlockType" AS ENUM ('Collection', 'Announcement', 'Leaderboard');

-- AlterTable
ALTER TABLE "HomeBlock" ADD COLUMN     "type" "HomeBlockType" NOT NULL;

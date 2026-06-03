-- CreateEnum
CREATE TYPE "PrizeMode" AS ENUM ('Fixed', 'Dynamic');
CREATE TYPE "PoolTrigger" AS ENUM ('Entry', 'User');

-- AlterTable
ALTER TABLE "Challenge"
  ADD COLUMN "prizeMode" "PrizeMode" NOT NULL DEFAULT 'Fixed',
  ADD COLUMN "basePrizePool" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "buzzPerAction" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "poolTrigger" "PoolTrigger",
  ADD COLUMN "maxPrizePool" INTEGER,
  ADD COLUMN "prizeDistribution" JSONB;

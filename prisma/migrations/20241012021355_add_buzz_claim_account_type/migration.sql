
-- CreateEnum
CREATE TYPE "BuzzAccountType" AS ENUM ('user', 'generation', 'club');

-- AlterTable
ALTER TABLE "BuzzClaim" ADD COLUMN     "accountType" "BuzzAccountType" NOT NULL DEFAULT 'user';
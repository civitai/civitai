
-- CreateEnum
CREATE TYPE "ApiKeyType" AS ENUM ('System', 'User');

ALTER TYPE "KeyScope" ADD VALUE 'Generate';

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "type" "ApiKeyType" NOT NULL DEFAULT 'User';

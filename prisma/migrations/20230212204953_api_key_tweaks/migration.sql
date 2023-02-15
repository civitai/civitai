-- DropIndex
DROP INDEX "ApiKey_key_userId_key";

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id");

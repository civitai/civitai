-- CreateEnum
CREATE TYPE "BlockImageReason" AS ENUM ('Ownership', 'CSAM', 'TOS');

-- CreateTable
CREATE TABLE "BlockedImage" (
    "hash" BIGINT NOT NULL,
    "reason" "BlockImageReason" NOT NULL DEFAULT 'Ownership',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedImage_pkey" PRIMARY KEY ("hash")
);

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "pHash" BIGINT NOT NULL;

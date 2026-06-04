-- AlterTable
ALTER TABLE "ModelVersion" ADD COLUMN     "verificationMessage" TEXT,
ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false;

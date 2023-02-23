-- AlterTable
ALTER TABLE "User" ADD COLUMN     "autoplayGifs" BOOLEAN DEFAULT true;

UPDATE "User" SET "autoplayGifs" = true;

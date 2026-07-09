/*
  Warnings:

  - A unique constraint covering the columns `[token]` on the table `Partner` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Partner" ADD COLUMN     "nsfw" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "poi" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "token" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Partner_token_key" ON "Partner"("token");

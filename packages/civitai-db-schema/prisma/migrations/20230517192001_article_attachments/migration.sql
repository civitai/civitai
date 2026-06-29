/*
  Warnings:

  - You are about to drop the `ArticleRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ImageRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelVersionRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PostRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TagRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserRank` table. If the table is not empty, all the data it contains will be lost.

*/

-- CreateTable
CREATE TABLE "File" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sizeKB" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "articleId" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "File_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "File_articleId_idx" ON "File" USING HASH ("articleId");

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

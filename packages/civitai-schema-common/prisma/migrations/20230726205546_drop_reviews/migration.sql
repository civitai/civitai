/*
  Warnings:

  - You are about to drop the column `reviewId` on the `Comment` table. All the data in the column will be lost.
  - You are about to drop the `ImagesOnModels` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ImagesOnReviews` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Review` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ReviewReaction` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ReviewReport` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('Image', 'Character', 'Text', 'Audio');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');

-- DropView
DROP VIEW "ImageConnection";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_reviewId_fkey";

-- DropForeignKey
ALTER TABLE "ImagesOnModels" DROP CONSTRAINT "ImagesOnModels_imageId_fkey";

-- DropForeignKey
ALTER TABLE "ImagesOnModels" DROP CONSTRAINT "ImagesOnModels_modelVersionId_fkey";

-- DropForeignKey
ALTER TABLE "ImagesOnReviews" DROP CONSTRAINT "ImagesOnReviews_imageId_fkey";

-- DropForeignKey
ALTER TABLE "ImagesOnReviews" DROP CONSTRAINT "ImagesOnReviews_reviewId_fkey";

-- DropForeignKey
ALTER TABLE "Review" DROP CONSTRAINT "Review_modelId_fkey";

-- DropForeignKey
ALTER TABLE "Review" DROP CONSTRAINT "Review_modelVersionId_fkey";

-- DropForeignKey
ALTER TABLE "Review" DROP CONSTRAINT "Review_userId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewReaction" DROP CONSTRAINT "ReviewReaction_reviewId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewReaction" DROP CONSTRAINT "ReviewReaction_userId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewReport" DROP CONSTRAINT "ReviewReport_reportId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewReport" DROP CONSTRAINT "ReviewReport_reviewId_fkey";

-- DropIndex
DROP INDEX "Comment_reviewId_idx";

-- AlterTable
ALTER TABLE "Comment" DROP COLUMN "reviewId";

-- DropTable
DROP TABLE "ImagesOnModels";

-- DropTable
DROP TABLE "ImagesOnReviews";

-- DropTable
DROP TABLE "Review";

-- DropTable
DROP TABLE "ReviewReaction";

-- DropTable
DROP TABLE "ReviewReport";


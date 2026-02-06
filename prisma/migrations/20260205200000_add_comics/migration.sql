-- Consolidated Comics Feature Migration
-- Combines all comic migrations into a single idempotent migration

-- Drop Thread.comicChapterId column first (has FK dependency on ComicChapter)
ALTER TABLE "Thread" DROP COLUMN IF EXISTS "comicChapterId";

-- Drop existing tables/constraints if they exist (for clean re-apply)
-- Drop both old snake_case names and new PascalCase names for idempotency
DROP TABLE IF EXISTS "ComicReferenceImage" CASCADE;
DROP TABLE IF EXISTS "ComicPanelReference" CASCADE;
DROP TABLE IF EXISTS "ComicPanelCharacter" CASCADE;
DROP TABLE IF EXISTS "comic_panel_references" CASCADE;
DROP TABLE IF EXISTS "ComicChapterRead" CASCADE;
DROP TABLE IF EXISTS "comic_chapter_reads" CASCADE;
DROP TABLE IF EXISTS "ComicProjectEngagement" CASCADE;
DROP TABLE IF EXISTS "comic_project_engagements" CASCADE;
DROP TABLE IF EXISTS "ComicPanel" CASCADE;
DROP TABLE IF EXISTS "comic_panels" CASCADE;
DROP TABLE IF EXISTS "ComicReference" CASCADE;
DROP TABLE IF EXISTS "ComicCharacter" CASCADE;
DROP TABLE IF EXISTS "comic_references" CASCADE;
DROP TABLE IF EXISTS "comic_characters" CASCADE;
DROP TABLE IF EXISTS "ComicChapter" CASCADE;
DROP TABLE IF EXISTS "comic_chapters" CASCADE;
DROP TABLE IF EXISTS "ComicProject" CASCADE;
DROP TABLE IF EXISTS "comic_projects" CASCADE;

-- Drop old enums if they exist
DROP TYPE IF EXISTS "ComicCharacterStatus";
DROP TYPE IF EXISTS "ComicCharacterSourceType";
DROP TYPE IF EXISTS "ComicReferenceStatus";
DROP TYPE IF EXISTS "ComicReferenceSourceType";
DROP TYPE IF EXISTS "ComicProjectStatus";
DROP TYPE IF EXISTS "ComicPanelStatus";
DROP TYPE IF EXISTS "ComicChapterStatus";
DROP TYPE IF EXISTS "ComicReferenceType";
DROP TYPE IF EXISTS "ComicEngagementType";
DROP TYPE IF EXISTS "ComicGenre";

-- Create enums
CREATE TYPE "ComicProjectStatus" AS ENUM ('Active', 'Deleted');
CREATE TYPE "ComicReferenceStatus" AS ENUM ('Pending', 'Ready', 'Failed');
CREATE TYPE "ComicPanelStatus" AS ENUM ('Pending', 'Generating', 'Ready', 'Failed');
CREATE TYPE "ComicChapterStatus" AS ENUM ('Draft', 'Published');
CREATE TYPE "ComicReferenceType" AS ENUM ('Character', 'Location', 'Item');
CREATE TYPE "ComicEngagementType" AS ENUM ('Notify', 'Hide');
CREATE TYPE "ComicGenre" AS ENUM ('Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mystery', 'Romance', 'SciFi', 'SliceOfLife', 'Thriller', 'Other');

-- CreateTable
CREATE TABLE "ComicProject" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "coverImageUrl" VARCHAR(500),
    "status" "ComicProjectStatus" NOT NULL DEFAULT 'Active',
    "baseModel" VARCHAR(50),
    "genre" "ComicGenre",
    "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComicProject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComicProject_userId_idx" ON "ComicProject"("userId");
CREATE INDEX "ComicProject_status_idx" ON "ComicProject"("status");

-- AddForeignKey
ALTER TABLE "ComicProject" ADD CONSTRAINT "ComicProject_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ComicChapter" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL DEFAULT 'Chapter 1',
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" "ComicChapterStatus" NOT NULL DEFAULT 'Draft',
    "publishedAt" TIMESTAMP(3),
    "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComicChapter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComicChapter_projectId_idx" ON "ComicChapter"("projectId");
CREATE INDEX "ComicChapter_projectId_position_idx" ON "ComicChapter"("projectId", "position");

-- AddForeignKey
ALTER TABLE "ComicChapter" ADD CONSTRAINT "ComicChapter_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "ComicProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ComicReference" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "userId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" "ComicReferenceType" NOT NULL DEFAULT 'Character',
    "description" TEXT,
    "status" "ComicReferenceStatus" NOT NULL DEFAULT 'Pending',
    "errorMessage" TEXT,
    "buzzCost" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComicReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComicReference_projectId_idx" ON "ComicReference"("projectId");
CREATE INDEX "ComicReference_userId_idx" ON "ComicReference"("userId");
CREATE INDEX "ComicReference_status_idx" ON "ComicReference"("status");

-- AddForeignKey
ALTER TABLE "ComicReference" ADD CONSTRAINT "ComicReference_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "ComicProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ComicReference" ADD CONSTRAINT "ComicReference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ComicReferenceImage" (
    "referenceId" TEXT NOT NULL,
    "imageId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComicReferenceImage_pkey" PRIMARY KEY ("referenceId","imageId")
);

-- CreateIndex
CREATE INDEX "ComicReferenceImage_imageId_idx" ON "ComicReferenceImage" USING HASH ("imageId");

-- AddForeignKey
ALTER TABLE "ComicReferenceImage" ADD CONSTRAINT "ComicReferenceImage_referenceId_fkey"
  FOREIGN KEY ("referenceId") REFERENCES "ComicReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicReferenceImage" ADD CONSTRAINT "ComicReferenceImage_imageId_fkey"
  FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ComicPanel" (
    "id" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "imageId" INTEGER,
    "prompt" TEXT NOT NULL,
    "enhancedPrompt" TEXT,
    "imageUrl" VARCHAR(500),
    "position" INTEGER NOT NULL DEFAULT 0,
    "buzzCost" INTEGER NOT NULL DEFAULT 25,
    "status" "ComicPanelStatus" NOT NULL DEFAULT 'Pending',
    "workflowId" TEXT,
    "civitaiJobId" VARCHAR(100),
    "errorMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComicPanel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComicPanel_chapterId_position_idx" ON "ComicPanel"("chapterId", "position");
CREATE INDEX "ComicPanel_imageId_idx" ON "ComicPanel"("imageId");
CREATE INDEX "ComicPanel_status_idx" ON "ComicPanel"("status");

-- AddForeignKey
ALTER TABLE "ComicPanel" ADD CONSTRAINT "ComicPanel_chapterId_fkey"
  FOREIGN KEY ("chapterId") REFERENCES "ComicChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicPanel" ADD CONSTRAINT "ComicPanel_imageId_fkey"
  FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ComicProjectEngagement" (
    "userId" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "ComicEngagementType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComicProjectEngagement_pkey" PRIMARY KEY ("userId","projectId")
);

-- CreateIndex
CREATE INDEX "ComicProjectEngagement_projectId_idx" ON "ComicProjectEngagement" USING HASH ("projectId");

-- AddForeignKey
ALTER TABLE "ComicProjectEngagement" ADD CONSTRAINT "ComicProjectEngagement_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicProjectEngagement" ADD CONSTRAINT "ComicProjectEngagement_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "ComicProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ComicChapterRead" (
    "userId" INTEGER NOT NULL,
    "chapterId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComicChapterRead_pkey" PRIMARY KEY ("userId","chapterId")
);

-- CreateIndex
CREATE INDEX "ComicChapterRead_chapterId_idx" ON "ComicChapterRead" USING HASH ("chapterId");

-- AddForeignKey
ALTER TABLE "ComicChapterRead" ADD CONSTRAINT "ComicChapterRead_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicChapterRead" ADD CONSTRAINT "ComicChapterRead_chapterId_fkey"
  FOREIGN KEY ("chapterId") REFERENCES "ComicChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ComicPanelReference" (
    "panelId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,

    CONSTRAINT "ComicPanelReference_pkey" PRIMARY KEY ("panelId","referenceId")
);

-- CreateIndex
CREATE INDEX "ComicPanelReference_referenceId_idx" ON "ComicPanelReference" USING HASH ("referenceId");

-- AddForeignKey
ALTER TABLE "ComicPanelReference" ADD CONSTRAINT "ComicPanelReference_panelId_fkey"
  FOREIGN KEY ("panelId") REFERENCES "ComicPanel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicPanelReference" ADD CONSTRAINT "ComicPanelReference_referenceId_fkey"
  FOREIGN KEY ("referenceId") REFERENCES "ComicReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add comicChapterId to Thread table
ALTER TABLE "Thread" ADD COLUMN "comicChapterId" TEXT;
CREATE UNIQUE INDEX "Thread_comicChapterId_key" ON "Thread"("comicChapterId");
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_comicChapterId_fkey"
  FOREIGN KEY ("comicChapterId") REFERENCES "ComicChapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

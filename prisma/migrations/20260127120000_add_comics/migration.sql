-- Comics MVP Migration
-- Create enums
CREATE TYPE "ComicProjectStatus" AS ENUM ('Active', 'Deleted');
CREATE TYPE "ComicCharacterStatus" AS ENUM ('Pending', 'Processing', 'Ready', 'Failed');
CREATE TYPE "ComicPanelStatus" AS ENUM ('Pending', 'Generating', 'Ready', 'Failed');

-- Create comic_projects table
CREATE TABLE "comic_projects" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "status" "ComicProjectStatus" NOT NULL DEFAULT 'Active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comic_projects_pkey" PRIMARY KEY ("id")
);

-- Create comic_characters table
CREATE TABLE "comic_characters" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "status" "ComicCharacterStatus" NOT NULL DEFAULT 'Pending',
    "referenceImages" JSONB,
    "faceEmbedding" JSONB,
    "characterEmbedding" JSONB,
    "civitaiJobId" VARCHAR(100),
    "errorMessage" TEXT,
    "buzzCost" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comic_characters_pkey" PRIMARY KEY ("id")
);

-- Create comic_panels table
CREATE TABLE "comic_panels" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "characterId" TEXT,
    "prompt" TEXT NOT NULL,
    "imageUrl" VARCHAR(500),
    "position" INTEGER NOT NULL DEFAULT 0,
    "buzzCost" INTEGER NOT NULL DEFAULT 25,
    "status" "ComicPanelStatus" NOT NULL DEFAULT 'Pending',
    "civitaiJobId" VARCHAR(100),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comic_panels_pkey" PRIMARY KEY ("id")
);

-- Add indexes
CREATE INDEX "comic_projects_userId_idx" ON "comic_projects"("userId");
CREATE INDEX "comic_projects_status_idx" ON "comic_projects"("status");

CREATE INDEX "comic_characters_projectId_idx" ON "comic_characters"("projectId");
CREATE INDEX "comic_characters_userId_idx" ON "comic_characters"("userId");
CREATE INDEX "comic_characters_status_idx" ON "comic_characters"("status");

CREATE INDEX "comic_panels_projectId_position_idx" ON "comic_panels"("projectId", "position");
CREATE INDEX "comic_panels_characterId_idx" ON "comic_panels"("characterId");
CREATE INDEX "comic_panels_status_idx" ON "comic_panels"("status");

-- Add foreign keys
ALTER TABLE "comic_projects" ADD CONSTRAINT "comic_projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comic_characters" ADD CONSTRAINT "comic_characters_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "comic_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comic_characters" ADD CONSTRAINT "comic_characters_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comic_panels" ADD CONSTRAINT "comic_panels_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "comic_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comic_panels" ADD CONSTRAINT "comic_panels_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "comic_characters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Destructive migration: Drop and recreate all comic tables with chapter support
-- Dev phase only — no data preservation needed

-- Drop tables in dependency order
DROP TABLE IF EXISTS "comic_panels";
DROP TABLE IF EXISTS "comic_chapters";
DROP TABLE IF EXISTS "comic_characters";
DROP TABLE IF EXISTS "comic_projects";

-- Recreate ComicProject
CREATE TABLE "comic_projects" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "status" "ComicProjectStatus" NOT NULL DEFAULT 'Active',
    "baseModel" VARCHAR(50),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comic_projects_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "comic_projects_userId_idx" ON "comic_projects"("userId");
CREATE INDEX "comic_projects_status_idx" ON "comic_projects"("status");

-- Recreate ComicChapter (NEW)
CREATE TABLE "comic_chapters" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL DEFAULT 'Chapter 1',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comic_chapters_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "comic_chapters_projectId_idx" ON "comic_chapters"("projectId");
CREATE INDEX "comic_chapters_projectId_position_idx" ON "comic_chapters"("projectId", "position");

-- Recreate ComicCharacter with new fields
CREATE TABLE "comic_characters" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "status" "ComicCharacterStatus" NOT NULL DEFAULT 'Pending',
    "sourceType" "ComicCharacterSourceType" NOT NULL DEFAULT 'Upload',
    "modelId" INTEGER,
    "modelVersionId" INTEGER,
    "referenceImages" JSONB,
    "trainingJobId" VARCHAR(100),
    "trainedModelId" INTEGER,
    "trainedModelVersionId" INTEGER,
    "generatedReferenceImages" JSONB,
    "referenceImageWorkflowIds" JSONB,
    "errorMessage" TEXT,
    "buzzCost" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comic_characters_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "comic_characters_projectId_idx" ON "comic_characters"("projectId");
CREATE INDEX "comic_characters_userId_idx" ON "comic_characters"("userId");
CREATE INDEX "comic_characters_status_idx" ON "comic_characters"("status");
CREATE INDEX "comic_characters_modelVersionId_idx" ON "comic_characters"("modelVersionId");

-- Recreate ComicPanel with chapterId instead of projectId
CREATE TABLE "comic_panels" (
    "id" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "characterId" TEXT,
    "prompt" TEXT NOT NULL,
    "enhancedPrompt" TEXT,
    "imageUrl" VARCHAR(500),
    "position" INTEGER NOT NULL DEFAULT 0,
    "buzzCost" INTEGER NOT NULL DEFAULT 25,
    "status" "ComicPanelStatus" NOT NULL DEFAULT 'Pending',
    "workflowId" TEXT,
    "civitaiJobId" VARCHAR(100),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comic_panels_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "comic_panels_chapterId_position_idx" ON "comic_panels"("chapterId", "position");
CREATE INDEX "comic_panels_characterId_idx" ON "comic_panels"("characterId");
CREATE INDEX "comic_panels_status_idx" ON "comic_panels"("status");

-- Foreign keys
ALTER TABLE "comic_projects" ADD CONSTRAINT "comic_projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comic_chapters" ADD CONSTRAINT "comic_chapters_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "comic_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comic_characters" ADD CONSTRAINT "comic_characters_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "comic_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comic_characters" ADD CONSTRAINT "comic_characters_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comic_panels" ADD CONSTRAINT "comic_panels_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "comic_chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comic_panels" ADD CONSTRAINT "comic_panels_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "comic_characters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

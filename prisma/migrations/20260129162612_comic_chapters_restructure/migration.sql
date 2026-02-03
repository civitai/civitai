-- Destructive migration: Drop and recreate all comic tables with chapter support
-- Dev phase only — no data preservation needed

-- Drop tables in dependency order
DROP TABLE IF EXISTS "ComicPanel";
DROP TABLE IF EXISTS "ComicChapter";
DROP TABLE IF EXISTS "ComicCharacter";
DROP TABLE IF EXISTS "ComicProject";

-- Recreate ComicProject
CREATE TABLE "ComicProject" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "status" "ComicProjectStatus" NOT NULL DEFAULT 'Active',
    "baseModel" VARCHAR(50),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComicProject_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ComicProject_userId_idx" ON "ComicProject"("userId");
CREATE INDEX "ComicProject_status_idx" ON "ComicProject"("status");

-- Recreate ComicChapter (NEW)
CREATE TABLE "ComicChapter" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL DEFAULT 'Chapter 1',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComicChapter_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ComicChapter_projectId_idx" ON "ComicChapter"("projectId");
CREATE INDEX "ComicChapter_projectId_position_idx" ON "ComicChapter"("projectId", "position");

-- Recreate ComicCharacter with new fields
CREATE TABLE "ComicCharacter" (
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

    CONSTRAINT "ComicCharacter_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ComicCharacter_projectId_idx" ON "ComicCharacter"("projectId");
CREATE INDEX "ComicCharacter_userId_idx" ON "ComicCharacter"("userId");
CREATE INDEX "ComicCharacter_status_idx" ON "ComicCharacter"("status");
CREATE INDEX "ComicCharacter_modelVersionId_idx" ON "ComicCharacter"("modelVersionId");

-- Recreate ComicPanel with chapterId instead of projectId
CREATE TABLE "ComicPanel" (
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

    CONSTRAINT "ComicPanel_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ComicPanel_chapterId_position_idx" ON "ComicPanel"("chapterId", "position");
CREATE INDEX "ComicPanel_characterId_idx" ON "ComicPanel"("characterId");
CREATE INDEX "ComicPanel_status_idx" ON "ComicPanel"("status");

-- Foreign keys
ALTER TABLE "ComicProject" ADD CONSTRAINT "ComicProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicChapter" ADD CONSTRAINT "ComicChapter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicCharacter" ADD CONSTRAINT "ComicCharacter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicCharacter" ADD CONSTRAINT "ComicCharacter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicPanel" ADD CONSTRAINT "ComicPanel_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "ComicChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicPanel" ADD CONSTRAINT "ComicPanel_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "ComicCharacter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

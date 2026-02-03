-- Comics MVP Migration
-- Create enums
CREATE TYPE "ComicProjectStatus" AS ENUM ('Active', 'Deleted');
CREATE TYPE "ComicCharacterStatus" AS ENUM ('Pending', 'Processing', 'Ready', 'Failed');
CREATE TYPE "ComicPanelStatus" AS ENUM ('Pending', 'Generating', 'Ready', 'Failed');

-- Create ComicProject table
CREATE TABLE "ComicProject" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "status" "ComicProjectStatus" NOT NULL DEFAULT 'Active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComicProject_pkey" PRIMARY KEY ("id")
);

-- Create ComicCharacter table
CREATE TABLE "ComicCharacter" (
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

    CONSTRAINT "ComicCharacter_pkey" PRIMARY KEY ("id")
);

-- Create ComicPanel table
CREATE TABLE "ComicPanel" (
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

    CONSTRAINT "ComicPanel_pkey" PRIMARY KEY ("id")
);

-- Add indexes
CREATE INDEX "ComicProject_userId_idx" ON "ComicProject"("userId");
CREATE INDEX "ComicProject_status_idx" ON "ComicProject"("status");

CREATE INDEX "ComicCharacter_projectId_idx" ON "ComicCharacter"("projectId");
CREATE INDEX "ComicCharacter_userId_idx" ON "ComicCharacter"("userId");
CREATE INDEX "ComicCharacter_status_idx" ON "ComicCharacter"("status");

CREATE INDEX "ComicPanel_projectId_position_idx" ON "ComicPanel"("projectId", "position");
CREATE INDEX "ComicPanel_characterId_idx" ON "ComicPanel"("characterId");
CREATE INDEX "ComicPanel_status_idx" ON "ComicPanel"("status");

-- Add foreign keys
ALTER TABLE "ComicProject" ADD CONSTRAINT "ComicProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ComicCharacter" ADD CONSTRAINT "ComicCharacter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicCharacter" ADD CONSTRAINT "ComicCharacter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ComicPanel" ADD CONSTRAINT "ComicPanel_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicPanel" ADD CONSTRAINT "ComicPanel_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "ComicCharacter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

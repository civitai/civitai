-- Create CrucibleStatus enum
CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');

-- Create Crucible table
CREATE TABLE IF NOT EXISTS "Crucible" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageId" INTEGER,
    "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
    "entryFee" INTEGER NOT NULL DEFAULT 0,
    "entryLimit" INTEGER NOT NULL DEFAULT 1,
    "maxTotalEntries" INTEGER,
    "prizePositions" JSONB NOT NULL DEFAULT '[]',
    "allowedResources" JSONB,
    "judgeRequirements" JSONB,
    "duration" INTEGER NOT NULL DEFAULT 480,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "status" "CrucibleStatus" NOT NULL DEFAULT 'Pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Crucible_pkey" PRIMARY KEY ("id")
);

-- Create CrucibleEntry table
CREATE TABLE IF NOT EXISTS "CrucibleEntry" (
    "id" SERIAL NOT NULL,
    "crucibleId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "imageId" INTEGER NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 1500,
    "position" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrucibleEntry_pkey" PRIMARY KEY ("id")
);

-- Add foreign key constraints for Crucible
ALTER TABLE "Crucible" ADD CONSTRAINT "Crucible_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Crucible" ADD CONSTRAINT "Crucible_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add foreign key constraints for CrucibleEntry
ALTER TABLE "CrucibleEntry" ADD CONSTRAINT "CrucibleEntry_crucibleId_fkey" FOREIGN KEY ("crucibleId") REFERENCES "Crucible"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrucibleEntry" ADD CONSTRAINT "CrucibleEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrucibleEntry" ADD CONSTRAINT "CrucibleEntry_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create indexes for Crucible
CREATE INDEX "Crucible_userId_idx" ON "Crucible" USING HASH ("userId");
CREATE INDEX "Crucible_status_idx" ON "Crucible"("status");
CREATE INDEX "Crucible_endAt_idx" ON "Crucible"("endAt");
CREATE INDEX "Crucible_startAt_idx" ON "Crucible"("startAt");

-- Create indexes for CrucibleEntry
CREATE INDEX "CrucibleEntry_crucibleId_idx" ON "CrucibleEntry" USING HASH ("crucibleId");
CREATE INDEX "CrucibleEntry_userId_idx" ON "CrucibleEntry" USING HASH ("userId");
CREATE INDEX "CrucibleEntry_crucibleId_score_idx" ON "CrucibleEntry"("crucibleId", "score" DESC);

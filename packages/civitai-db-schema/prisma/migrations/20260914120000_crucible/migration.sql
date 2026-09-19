-- Crucible: head-to-head content judging.
--
-- Fully idempotent, so re-applying to a database that already has part of it is a safe no-op. That
-- matters here because this migration was revised three times after it was first applied to dev
-- (contentType, seededPrizePool + seedTransactionId added; judgeRequirements removed), and the
-- environments are updated by hand rather than by `prisma migrate deploy`.

-- Enum (create if missing).
DO $$ BEGIN
  CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create Crucible table
CREATE TABLE IF NOT EXISTS "Crucible" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageId" INTEGER,
    "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
    "contentType" "MediaType" NOT NULL DEFAULT 'image',
    "entryFee" INTEGER NOT NULL DEFAULT 0,
    "seededPrizePool" INTEGER NOT NULL DEFAULT 0,
    "entryLimit" INTEGER NOT NULL DEFAULT 1,
    "maxTotalEntries" INTEGER,
    "prizePositions" JSONB NOT NULL DEFAULT '[]',
    "allowedResources" JSONB,
    "duration" INTEGER NOT NULL DEFAULT 480,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "status" "CrucibleStatus" NOT NULL DEFAULT 'Pending',
    "buzzTransactionId" TEXT,
    "seedTransactionId" TEXT,
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
    "voteCount" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER,
    "buzzTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrucibleEntry_pkey" PRIMARY KEY ("id")
);

-- Foreign keys (add if missing). Postgres has no ADD CONSTRAINT IF NOT EXISTS, hence the block.
DO $$ BEGIN
  ALTER TABLE "Crucible" ADD CONSTRAINT "Crucible_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Crucible" ADD CONSTRAINT "Crucible_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CrucibleEntry" ADD CONSTRAINT "CrucibleEntry_crucibleId_fkey" FOREIGN KEY ("crucibleId") REFERENCES "Crucible"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CrucibleEntry" ADD CONSTRAINT "CrucibleEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CrucibleEntry" ADD CONSTRAINT "CrucibleEntry_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create indexes for Crucible
CREATE INDEX IF NOT EXISTS "Crucible_userId_idx" ON "Crucible" USING HASH ("userId");
CREATE INDEX IF NOT EXISTS "Crucible_status_idx" ON "Crucible"("status");
CREATE INDEX IF NOT EXISTS "Crucible_endAt_idx" ON "Crucible"("endAt");
CREATE INDEX IF NOT EXISTS "Crucible_startAt_idx" ON "Crucible"("startAt");

-- Create indexes for CrucibleEntry
CREATE INDEX IF NOT EXISTS "CrucibleEntry_crucibleId_idx" ON "CrucibleEntry" USING HASH ("crucibleId");
CREATE INDEX IF NOT EXISTS "CrucibleEntry_userId_idx" ON "CrucibleEntry" USING HASH ("userId");
CREATE INDEX IF NOT EXISTS "CrucibleEntry_crucibleId_score_idx" ON "CrucibleEntry"("crucibleId", "score" DESC);

-- For databases where the tables pre-existed at an earlier revision of this migration.
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "contentType" "MediaType" NOT NULL DEFAULT 'image';
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "seededPrizePool" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "seedTransactionId" TEXT;
ALTER TABLE "Crucible" DROP COLUMN IF EXISTS "judgeRequirements";

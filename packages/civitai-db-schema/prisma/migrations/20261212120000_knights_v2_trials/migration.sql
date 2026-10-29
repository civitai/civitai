-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights app build that serves Trials and runs the harvest job.
CREATE TABLE IF NOT EXISTS "KnightsReferenceImage" (
  "id" SERIAL PRIMARY KEY,
  "imageId" INTEGER NOT NULL,
  "questionKey" TEXT NOT NULL DEFAULT 'knights.image.nsfwLevel',
  "pool" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "explanation" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "modActivityId" INTEGER,
  "harvestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answers" INTEGER NOT NULL DEFAULT 0,
  "failures" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Unique across modules on purpose: one known answer per image, in one pool, never both.
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsReferenceImage_imageId_key" ON "KnightsReferenceImage" ("imageId");
CREATE INDEX IF NOT EXISTS "KnightsReferenceImage_pool_status_source_idx" ON "KnightsReferenceImage" ("pool", "status", "source");
CREATE INDEX IF NOT EXISTS "KnightsReferenceImage_modActivityId_idx" ON "KnightsReferenceImage" ("modActivityId");

CREATE TABLE IF NOT EXISTS "KnightsTrialRun" (
  "id" SERIAL PRIMARY KEY,
  "playerId" INTEGER NOT NULL,
  "questionKey" TEXT NOT NULL,
  "seed" INTEGER NOT NULL,
  "itemIds" JSONB NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "result" TEXT,
  "score" DOUBLE PRECISION,
  "cooldownUntil" TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "KnightsTrialRun_playerId_questionKey_startedAt_idx" ON "KnightsTrialRun" ("playerId", "questionKey", "startedAt");
-- Not expressible in Prisma: at most one unfinished run per player and module.
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsTrialRun_one_open_per_module"
  ON "KnightsTrialRun" ("playerId", "questionKey") WHERE "finishedAt" IS NULL;

CREATE TABLE IF NOT EXISTS "KnightsTrialAnswer" (
  "id" SERIAL PRIMARY KEY,
  "runId" INTEGER NOT NULL REFERENCES "KnightsTrialRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "playerId" INTEGER NOT NULL,
  "referenceId" INTEGER NOT NULL REFERENCES "KnightsReferenceImage"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "answer" TEXT NOT NULL,
  "correct" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "KnightsTrialAnswer_runId_referenceId_key" ON "KnightsTrialAnswer" ("runId", "referenceId");
CREATE INDEX IF NOT EXISTS "KnightsTrialAnswer_playerId_createdAt_idx" ON "KnightsTrialAnswer" ("playerId", "createdAt");
CREATE INDEX IF NOT EXISTS "KnightsTrialAnswer_referenceId_idx" ON "KnightsTrialAnswer" ("referenceId");

CREATE TABLE IF NOT EXISTS "KnightsHarvestCursor" (
  "name" TEXT PRIMARY KEY,
  "lastActivityId" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

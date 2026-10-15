-- Idempotent: applied by hand, possibly more than once.
--
-- Apply before the deploy that reads it: until then the nightly score job's
-- `models` category fails and its checkpoint stays frozen (the other categories still run).

CREATE TABLE IF NOT EXISTS "ModelSelfGeneration" (
  "modelId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "generationCount" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModelSelfGeneration_pkey" PRIMARY KEY ("modelId", "userId")
);

CREATE INDEX IF NOT EXISTS "ModelSelfGeneration_userId_idx" ON "ModelSelfGeneration"("userId");

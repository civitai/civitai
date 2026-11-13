-- Idempotent: applied by hand, possibly more than once.
--
-- Images whose removal no longer counts against the owner's Creator Score. Written only by the
-- backfill route. Apply BEFORE deploying: the score job and the removed-images list query it
-- unconditionally.

CREATE TABLE IF NOT EXISTS "RemovalScoreExemption" (
  "imageId" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" INTEGER,
  CONSTRAINT "RemovalScoreExemption_pkey" PRIMARY KEY ("imageId")
);

CREATE INDEX IF NOT EXISTS "RemovalScoreExemption_createdAt_idx" ON "RemovalScoreExemption" ("createdAt");

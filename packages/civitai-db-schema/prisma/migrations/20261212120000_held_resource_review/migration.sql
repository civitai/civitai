-- Apply by hand, BEFORE the deploy: every hard delete of a Model, ModelVersion or Question writes
-- to these tables in its own statement, so without them those deletes fail.
CREATE TABLE IF NOT EXISTS "HeldResourceReview" (
  "id" INTEGER NOT NULL,
  "modelId" INTEGER NOT NULL,
  "modelVersionId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "rating" INTEGER NOT NULL,
  "recommended" BOOLEAN NOT NULL,
  "details" TEXT,
  "exclude" BOOLEAN NOT NULL,
  "nsfw" BOOLEAN NOT NULL,
  "tosViolation" BOOLEAN NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "holdReasons" TEXT[],
  CONSTRAINT "HeldResourceReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "HeldResourceReview_userId_idx" ON "HeldResourceReview" ("userId");

CREATE TABLE IF NOT EXISTS "HeldAnswer" (
  "id" INTEGER NOT NULL,
  "questionId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "holdReasons" TEXT[],
  CONSTRAINT "HeldAnswer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "HeldAnswer_userId_idx" ON "HeldAnswer" ("userId");

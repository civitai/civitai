-- CreateTable
CREATE TABLE IF NOT EXISTS "AppPageAccess" (
  "app" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "updatedById" INTEGER,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AppPageAccess_pkey" PRIMARY KEY ("app", "path")
);

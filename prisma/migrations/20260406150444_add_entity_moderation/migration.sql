-- CreateEnum
CREATE TYPE "EntityModerationStatus" AS ENUM ('Pending', 'Succeeded', 'Failed', 'Expired', 'Canceled');

-- CreateTable
CREATE TABLE "EntityModeration" (
  "id" SERIAL NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" INTEGER NOT NULL,
  "workflowId" TEXT,
  "status" "EntityModerationStatus" NOT NULL DEFAULT 'Pending',
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "blocked" BOOLEAN,
  "triggeredLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "result" JSONB,
  "contentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EntityModeration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EntityModeration_entityType_entityId_key" ON "EntityModeration"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "EntityModeration_status_idx" ON "EntityModeration"("status");

-- CreateIndex
CREATE INDEX "EntityModeration_workflowId_idx" ON "EntityModeration"("workflowId");

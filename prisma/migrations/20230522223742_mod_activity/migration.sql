-- CreateTable
CREATE TABLE "ModActivity" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "activity" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModActivity_createdAt_idx" ON "ModActivity"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ModActivity_activity_entityType_entityId_key" ON "ModActivity"("activity", "entityType", "entityId");

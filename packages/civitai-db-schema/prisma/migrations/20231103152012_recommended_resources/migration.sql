BEGIN;
-- AlterTable
ALTER TABLE "ModelVersion" ADD COLUMN     "settings" JSONB;

-- CreateTable
CREATE TABLE "RecommendedResource" (
    "id" SERIAL NOT NULL,
    "resourceId" INTEGER NOT NULL,
    "sourceId" INTEGER,
    "settings" JSONB,

    CONSTRAINT "RecommendedResource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecommendedResource_sourceId_idx" ON "RecommendedResource" USING HASH ("sourceId");

-- AddForeignKey
ALTER TABLE "RecommendedResource" ADD CONSTRAINT "RecommendedResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendedResource" ADD CONSTRAINT "RecommendedResource_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;

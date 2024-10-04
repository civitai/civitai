-- AlterTable
ALTER TABLE "ModelFlag" DROP COLUMN "nameNsfw",
ADD COLUMN     "poiName" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ModelFlag_status_idx" ON "ModelFlag"("status");

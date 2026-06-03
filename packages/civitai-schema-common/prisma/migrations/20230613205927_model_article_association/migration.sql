-- AlterTable
ALTER TABLE "ModelAssociations" DROP CONSTRAINT "ModelAssociations_pkey",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD COLUMN     "toArticleId" INTEGER,
ADD CONSTRAINT "ModelAssociations_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE INDEX "ModelAssociations_fromModelId_idx" ON "ModelAssociations" USING HASH ("fromModelId");

-- CreateIndex
CREATE INDEX "ModelAssociations_toArticleId_idx" ON "ModelAssociations" USING HASH ("toArticleId");

-- AddForeignKey
ALTER TABLE "ModelAssociations" ADD CONSTRAINT "ModelAssociations_toArticleId_fkey" FOREIGN KEY ("toArticleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

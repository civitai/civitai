-- DropForeignKey
ALTER TABLE "ModelAssociations" DROP CONSTRAINT "ModelAssociations_fromModelId_fkey";

-- DropForeignKey
ALTER TABLE "ModelAssociations" DROP CONSTRAINT "ModelAssociations_toArticleId_fkey";

-- DropForeignKey
ALTER TABLE "ModelAssociations" DROP CONSTRAINT "ModelAssociations_toModelId_fkey";

-- AddForeignKey
ALTER TABLE "ModelAssociations" ADD CONSTRAINT "ModelAssociations_fromModelId_fkey" FOREIGN KEY ("fromModelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelAssociations" ADD CONSTRAINT "ModelAssociations_toModelId_fkey" FOREIGN KEY ("toModelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelAssociations" ADD CONSTRAINT "ModelAssociations_toArticleId_fkey" FOREIGN KEY ("toArticleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

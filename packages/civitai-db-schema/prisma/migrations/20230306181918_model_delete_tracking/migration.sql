-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "deletedBy" INTEGER;

-- AddForeignKey
ALTER TABLE "Model" ADD CONSTRAINT "Model_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

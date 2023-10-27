-- AlterTable
ALTER TABLE "HomeBlock" ADD COLUMN     "permanent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourceId" INTEGER,
ALTER COLUMN "index" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "HomeBlock" ADD CONSTRAINT "HomeBlock_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "HomeBlock"("id") ON DELETE SET NULL ON UPDATE CASCADE;

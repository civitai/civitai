-- DropForeignKey
ALTER TABLE "ModelHash" DROP CONSTRAINT "ModelHash_fileId_fkey";

-- AddForeignKey
ALTER TABLE "ModelHash" ADD CONSTRAINT "ModelHash_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "ModelFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

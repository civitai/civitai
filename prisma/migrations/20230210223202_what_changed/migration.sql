-- AlterTable
ALTER TABLE "ModelFileHash" RENAME CONSTRAINT "ModelHash_pkey" TO "ModelFileHash_pkey";

-- RenameForeignKey
ALTER TABLE "ModelFileHash" RENAME CONSTRAINT "ModelHash_fileId_fkey" TO "ModelFileHash_fileId_fkey";

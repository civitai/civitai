-- CreateEnum
CREATE TYPE "ModelHashType" AS ENUM ('AutoV1', 'SHA256', 'CRC');

-- CreateTable
CREATE TABLE "ModelHash" (
    "modelVersionId" INTEGER NOT NULL,
    "type" "ModelHashType" NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelHash_pkey" PRIMARY KEY ("modelVersionId","type")
);

-- AddForeignKey
ALTER TABLE "ModelHash" ADD CONSTRAINT "ModelHash_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

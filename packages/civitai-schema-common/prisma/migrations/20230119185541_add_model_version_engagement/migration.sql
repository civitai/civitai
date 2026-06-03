-- CreateEnum
CREATE TYPE "ModelVersionEngagementType" AS ENUM ('Notify');

-- CreateTable
CREATE TABLE "ModelVersionEngagement" (
    "userId" INTEGER NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "type" "ModelVersionEngagementType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelVersionEngagement_pkey" PRIMARY KEY ("userId","modelVersionId")
);

-- AddForeignKey
ALTER TABLE "ModelVersionEngagement" ADD CONSTRAINT "ModelVersionEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelVersionEngagement" ADD CONSTRAINT "ModelVersionEngagement_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

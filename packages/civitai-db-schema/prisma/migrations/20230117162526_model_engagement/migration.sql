-- CreateEnum
CREATE TYPE "ModelEngagementType" AS ENUM ('Favorite', 'Hide');

-- CreateTable
CREATE TABLE "ModelEngagement" (
    "userId" INTEGER NOT NULL,
    "modelId" INTEGER NOT NULL,
    "type" "ModelEngagementType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelEngagement_pkey" PRIMARY KEY ("userId","modelId")
);

-- AddForeignKey
ALTER TABLE "ModelEngagement" ADD CONSTRAINT "ModelEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelEngagement" ADD CONSTRAINT "ModelEngagement_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

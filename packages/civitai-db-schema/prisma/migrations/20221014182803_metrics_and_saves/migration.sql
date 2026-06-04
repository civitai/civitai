-- CreateEnum
CREATE TYPE "UserActivityType" AS ENUM ('ModelDownload');

-- AlterTable
ALTER TABLE "Review" ALTER COLUMN "text" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ModelMetric" (
    "modelId" INTEGER NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "ratingCount" INTEGER NOT NULL,
    "downloadCount" INTEGER NOT NULL,

    CONSTRAINT "ModelMetric_pkey" PRIMARY KEY ("modelId","modelVersionId")
);

-- CreateTable
CREATE TABLE "UserActivity" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "activity" "UserActivityType" NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedModel" (
    "modelId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedModel_pkey" PRIMARY KEY ("modelId","userId")
);

-- AddForeignKey
ALTER TABLE "ModelMetric" ADD CONSTRAINT "ModelMetric_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelMetric" ADD CONSTRAINT "ModelMetric_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserActivity" ADD CONSTRAINT "UserActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedModel" ADD CONSTRAINT "SavedModel_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedModel" ADD CONSTRAINT "SavedModel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

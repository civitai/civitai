-- CreateEnum
CREATE TYPE "PartnerPricingModel" AS ENUM ('Duration', 'PerImage');

-- AlterEnum
ALTER TYPE "UserActivityType" ADD VALUE 'ModelRun';

-- CreateTable
CREATE TABLE "RunStrategy" (
    "id" SERIAL NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunStrategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Partner" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "homepage" TEXT,
    "tos" TEXT,
    "privacy" TEXT,
    "startupTime" INTEGER,
    "onDemand" BOOLEAN NOT NULL,
    "stepsPerSecond" INTEGER NOT NULL,
    "pricingModel" "PartnerPricingModel" NOT NULL,
    "price" TEXT NOT NULL,
    "about" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "RunStrategy" ADD CONSTRAINT "RunStrategy_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunStrategy" ADD CONSTRAINT "RunStrategy_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "ModelVersionSponsorshipSettingsType" AS ENUM ('FixedPrice', 'Bidding');

-- CreateEnum
CREATE TYPE "ModelVersionMonetizationType" AS ENUM ('PaidAccess', 'PaidEarlyAccess', 'CivitaiClubOnly', 'MySubscribersOnly', 'Sponsored');

-- CreateTable
CREATE TABLE "ModelVersionSponsorshipSettings" (
    "id" SERIAL NOT NULL,
    "modelVersionMonetizationId" INTEGER NOT NULL,
    "type" "ModelVersionSponsorshipSettingsType" NOT NULL DEFAULT 'FixedPrice',
    "currency" TEXT NOT NULL,
    "unitAmount" INTEGER NOT NULL,

    CONSTRAINT "ModelVersionSponsorshipSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelVersionMonetization" (
    "id" SERIAL NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "type" "ModelVersionMonetizationType" NOT NULL DEFAULT 'PaidAccess',
    "currency" TEXT NOT NULL,
    "unitAmount" INTEGER,

    CONSTRAINT "ModelVersionMonetization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelVersionSponsorshipSettings_modelVersionMonetizationId_key" ON "ModelVersionSponsorshipSettings"("modelVersionMonetizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelVersionMonetization_modelVersionId_key" ON "ModelVersionMonetization"("modelVersionId");

-- AddForeignKey
ALTER TABLE "ModelVersionSponsorshipSettings" ADD CONSTRAINT "ModelVersionSponsorshipSettings_modelVersionMonetizationId_fkey" FOREIGN KEY ("modelVersionMonetizationId") REFERENCES "ModelVersionMonetization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelVersionMonetization" ADD CONSTRAINT "ModelVersionMonetization_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

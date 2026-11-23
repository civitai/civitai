-- P2: license presets on service offerings, frozen onto each deal at request time.
CREATE TYPE "ServiceLicensePreset" AS ENUM ('Personal', 'CommercialCredit', 'CommercialNoCredit', 'Custom');

ALTER TABLE "ServiceOffering"
  ADD COLUMN "licensePreset" "ServiceLicensePreset",
  ADD COLUMN "licenseCustomText" TEXT,
  ADD COLUMN "licenseAllowResale" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ServiceDeal"
  ADD COLUMN "licensePreset" "ServiceLicensePreset",
  ADD COLUMN "licenseCustomText" TEXT,
  ADD COLUMN "licenseAllowResale" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "licenseAgreedAt" TIMESTAMP(3);

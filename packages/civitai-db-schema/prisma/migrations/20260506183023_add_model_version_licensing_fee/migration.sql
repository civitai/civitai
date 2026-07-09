-- CreateEnum
CREATE TYPE "LicensingFeeType" AS ENUM ('PerImageBuzz');

-- CreateEnum
CREATE TYPE "LicensingFeeSettlementCurrency" AS ENUM ('Buzz', 'Cash');

-- AlterTable
ALTER TABLE "ModelVersion"
  ADD COLUMN "licensingFee" INTEGER,
  ADD COLUMN "licensingFeeType" "LicensingFeeType" DEFAULT 'PerImageBuzz',
  ADD COLUMN "licensingFeeSettlementCurrency" "LicensingFeeSettlementCurrency" DEFAULT 'Buzz';

-- AlterTable
ALTER TABLE "ModelVersionMonetization"
ALTER COLUMN "currency" SET DATA TYPE "Currency" USING currency::"Currency",
ALTER COLUMN "currency" SET NOT NULL,
ALTER COLUMN "currency" SET DEFAULT 'BUZZ';


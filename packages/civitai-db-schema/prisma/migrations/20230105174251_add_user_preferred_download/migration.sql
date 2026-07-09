-- AlterTable

ALTER TABLE "User" ADD COLUMN "preferredModelFormat" "ModelFileFormat" DEFAULT 'SafeTensor',
                                                                               ADD COLUMN "preferredPrunedModel" BOOLEAN DEFAULT false;


UPDATE "User"
SET "preferredModelFormat" = 'SafeTensor',
    "preferredPrunedModel" = false;


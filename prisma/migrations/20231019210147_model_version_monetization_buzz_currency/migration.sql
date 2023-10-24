
BEGIN;

UPDATE "ModelVersionMonetization" SET "unitAmount" = "unitAmount" * 10 WHERE "unitAmount" IS NOT NULL;
UPDATE "ModelVersionSponsorshipSettings" SET "unitAmount" = "unitAmount" * 10 WHERE "unitAmount" IS NOT NULL;
 -- AlterTable
ALTER TABLE "ModelVersionMonetization" DROP COLUMN "currency",
ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'BUZZ';

-- AlterTable
ALTER TABLE "ModelVersionSponsorshipSettings" DROP COLUMN "currency",
ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'BUZZ';

COMMIT;

BEGIN;
-- AlterTable
ALTER TABLE "Club" DROP COLUMN "buzzAccountId";

-- AlterTable
ALTER TABLE "ClubMembership" ALTER COLUMN "expiresAt" DROP NOT NULL;
COMMIT;

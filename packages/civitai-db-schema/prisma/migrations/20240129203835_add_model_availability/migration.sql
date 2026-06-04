-- AlterEnum
ALTER TYPE "Availability" ADD VALUE 'Unsearchable';

-- AlterTable
ALTER TABLE "Bounty" ADD COLUMN     "availability" "Availability" NOT NULL DEFAULT 'Public';

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "availability" "Availability" NOT NULL DEFAULT 'Public';

-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "availability" "Availability" NOT NULL DEFAULT 'Public';
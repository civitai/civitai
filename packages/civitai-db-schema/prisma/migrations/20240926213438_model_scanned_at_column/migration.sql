-- CreateEnum
CREATE TYPE "ModelFlagStatus" AS ENUM ('Pending', 'Resolved');

-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "scannedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ModelFlag" ADD COLUMN     "minor" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nsfw" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "poi" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" "ModelFlagStatus" NOT NULL DEFAULT 'Pending',
ADD COLUMN     "triggerWords" BOOLEAN NOT NULL DEFAULT false;

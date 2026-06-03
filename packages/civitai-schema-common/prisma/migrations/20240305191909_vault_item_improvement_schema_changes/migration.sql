-- DropForeignKey
ALTER TABLE "VaultItem" DROP CONSTRAINT "VaultItem_modelId_fkey";

-- DropForeignKey
ALTER TABLE "VaultItem" DROP CONSTRAINT "VaultItem_modelVersionId_fkey";

-- AlterTable
ALTER TABLE "VaultItem" DROP COLUMN "hash",
ADD COLUMN     "files" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "modelVersionId" SET NOT NULL,
ALTER COLUMN "modelId" SET NOT NULL;

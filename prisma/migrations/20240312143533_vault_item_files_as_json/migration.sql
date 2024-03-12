-- AlterTable
ALTER TABLE "VaultItem" DROP COLUMN "files",
ADD COLUMN     "files" JSONB NOT NULL DEFAULT '[]';

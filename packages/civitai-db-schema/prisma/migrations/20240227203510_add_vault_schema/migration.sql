-- CreateEnum
CREATE TYPE "VaultItemStatus" AS ENUM ('Pending', 'Stored', 'Failed');

-- CreateTable
CREATE TABLE "VaultItem" (
    "id" SERIAL NOT NULL,
    "vaultId" INTEGER NOT NULL,
    "status" "VaultItemStatus" NOT NULL DEFAULT 'Pending',
    "hash" TEXT NOT NULL,
    "modelVersionId" INTEGER,
    "modelId" INTEGER,
    "modelName" TEXT NOT NULL,
    "versionName" TEXT NOT NULL,
    "creatorId" INTEGER,
    "creatorName" TEXT NOT NULL,
    "type" "ModelType" NOT NULL,
    "baseModel" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refreshedAt" TIMESTAMP(3),
    "modelSizeKB" INTEGER NOT NULL,
    "detailsSizeKB" INTEGER NOT NULL,
    "imagesSizeKB" INTEGER NOT NULL,
    "notes" TEXT,

    CONSTRAINT "VaultItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vault" (
    "userId" INTEGER NOT NULL,
    "storageKb" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Vault_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "VaultItem" ADD CONSTRAINT "VaultItem_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "Vault"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultItem" ADD CONSTRAINT "VaultItem_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultItem" ADD CONSTRAINT "VaultItem_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultItem" ADD CONSTRAINT "VaultItem_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vault" ADD CONSTRAINT "Vault_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

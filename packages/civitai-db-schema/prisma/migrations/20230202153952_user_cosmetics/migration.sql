-- CreateEnum
CREATE TYPE "CosmeticType" AS ENUM ('Badge', 'NamePlate');

-- CreateEnum
CREATE TYPE "CosmeticSource" AS ENUM ('Trophy', 'Purchase', 'Event', 'Membership');

-- CreateTable
CREATE TABLE "Cosmetic" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "CosmeticType" NOT NULL,
    "source" "CosmeticSource" NOT NULL,
    "permanentUnlock" BOOLEAN NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "Cosmetic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCosmetic" (
    "userId" INTEGER NOT NULL,
    "cosmeticId" INTEGER NOT NULL,
    "obtainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "equippedAt" TIMESTAMP(3),

    CONSTRAINT "UserCosmetic_pkey" PRIMARY KEY ("userId","cosmeticId")
);

-- AddForeignKey
ALTER TABLE "UserCosmetic" ADD CONSTRAINT "UserCosmetic_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCosmetic" ADD CONSTRAINT "UserCosmetic_cosmeticId_fkey" FOREIGN KEY ("cosmeticId") REFERENCES "Cosmetic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

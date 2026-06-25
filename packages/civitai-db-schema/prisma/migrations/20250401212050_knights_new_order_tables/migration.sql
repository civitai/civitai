-- CreateEnum
CREATE TYPE "NewOrderRankType" AS ENUM ('Acolyte', 'Knight', 'Templar');

-- CreateTable
CREATE TABLE "NewOrderPlayer" (
    "userId" INTEGER NOT NULL,
    "rankType" "NewOrderRankType" NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exp" INTEGER NOT NULL DEFAULT 0,
    "fervor" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "NewOrderPlayer_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "NewOrderRank" (
    "type" "NewOrderRankType" NOT NULL,
    "name" TEXT NOT NULL,
    "minExp" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewOrderRank_pkey" PRIMARY KEY ("type")
);

-- CreateTable
CREATE TABLE "NewOrderSmite" (
    "id" SERIAL NOT NULL,
    "targetPlayerId" INTEGER NOT NULL,
    "givenById" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleansedAt" TIMESTAMP(3),
    "cleansedReason" TEXT,

    CONSTRAINT "NewOrderSmite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NewOrderPlayer_userId_key" ON "NewOrderPlayer"("userId");

-- AddForeignKey
ALTER TABLE "NewOrderPlayer" ADD CONSTRAINT "NewOrderPlayer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewOrderPlayer" ADD CONSTRAINT "NewOrderPlayer_rankType_fkey" FOREIGN KEY ("rankType") REFERENCES "NewOrderRank"("type") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewOrderSmite" ADD CONSTRAINT "NewOrderSmite_targetPlayerId_fkey" FOREIGN KEY ("targetPlayerId") REFERENCES "NewOrderPlayer"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewOrderSmite" ADD CONSTRAINT "NewOrderSmite_givenById_fkey" FOREIGN KEY ("givenById") REFERENCES "NewOrderPlayer"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

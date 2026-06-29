-- CreateEnum
CREATE TYPE "RedeemableCodeType" AS ENUM ('Buzz', 'Membership');

-- CreateTable
CREATE TABLE "RedeemableCode" (
    "code" TEXT NOT NULL,
    "unitValue" INTEGER NOT NULL,
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "RedeemableCodeType" NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "transactionId" TEXT,

    CONSTRAINT "RedeemableCode_pkey" PRIMARY KEY ("code")
);

-- AddForeignKey
ALTER TABLE "RedeemableCode" ADD CONSTRAINT "RedeemableCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

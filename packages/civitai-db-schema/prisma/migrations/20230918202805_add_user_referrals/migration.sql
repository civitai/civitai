-- CreateTable
CREATE TABLE "UserReferral" (
    "id" SERIAL NOT NULL,
    "userReferralCodeId" INTEGER,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    "note" TEXT,

    CONSTRAINT "UserReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserReferralCode" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "note" TEXT NOT NULL,

    CONSTRAINT "UserReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserReferral_userId_key" ON "UserReferral"("userId");

-- AddForeignKey
ALTER TABLE "UserReferral" ADD CONSTRAINT "UserReferral_userReferralCodeId_fkey" FOREIGN KEY ("userReferralCodeId") REFERENCES "UserReferralCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReferral" ADD CONSTRAINT "UserReferral_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReferralCode" ADD CONSTRAINT "UserReferralCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "StripeConnectStatus" AS ENUM ('PendingOnboarding', 'Approved', 'PendingVerification', 'Rejected');

-- CreateTable
CREATE TABLE "UserStripeConnect" (
    "userId" INTEGER NOT NULL,
    "connectedAccountId" TEXT NOT NULL,
    "status" "StripeConnectStatus" NOT NULL DEFAULT 'PendingOnboarding',
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "chargesEnabled" BOOLEAN NOT NULL DEFAULT false
);

-- CreateIndex
CREATE UNIQUE INDEX "UserStripeConnect_userId_key" ON "UserStripeConnect"("userId");

-- AddForeignKey
ALTER TABLE "UserStripeConnect" ADD CONSTRAINT "UserStripeConnect_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

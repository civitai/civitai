-- AlterTable
ALTER TABLE "UserReferralCode" ALTER COLUMN "note" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "UserReferralCode_code_key" ON "UserReferralCode"("code");

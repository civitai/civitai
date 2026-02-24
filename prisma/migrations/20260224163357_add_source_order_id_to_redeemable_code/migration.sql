-- AlterTable
ALTER TABLE "RedeemableCode" ADD COLUMN "sourceOrderId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RedeemableCode_sourceOrderId_key" ON "RedeemableCode"("sourceOrderId");

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "paddleCustomerId" TEXT;
-- CreateIndex
CREATE UNIQUE INDEX "User_paddleCustomerId_key" ON "User"("paddleCustomerId");
 
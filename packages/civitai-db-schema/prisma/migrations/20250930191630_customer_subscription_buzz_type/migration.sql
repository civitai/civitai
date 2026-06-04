-- DropIndex
DROP INDEX "CustomerSubscription_userId_key";

-- AlterTable
ALTER TABLE "CustomerSubscription" ADD COLUMN     "buzzType" TEXT NOT NULL DEFAULT 'yellow';

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSubscription_userId_buzzType_key" ON "CustomerSubscription"("userId", "buzzType");
 
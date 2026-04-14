-- AlterTable: Add accountType to Bid
ALTER TABLE "Bid" ADD COLUMN "accountType" TEXT NOT NULL DEFAULT 'yellow';

-- Update unique index on Bid to include accountType
DROP INDEX "Bid_auctionId_userId_entityId_key";
CREATE UNIQUE INDEX "Bid_auctionId_userId_entityId_accountType_key" ON "Bid"("auctionId", "userId", "entityId", "accountType");

-- Update unique index on BidRecurring to include accountType
DROP INDEX "BidRecurring_auctionBaseId_userId_entityId_key";
CREATE UNIQUE INDEX "BidRecurring_auctionBaseId_userId_entityId_accountType_key" ON "BidRecurring"("auctionBaseId", "userId", "entityId", "accountType");

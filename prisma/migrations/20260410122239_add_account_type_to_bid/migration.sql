-- AlterTable: Add accountType to Bid
ALTER TABLE "Bid" ADD COLUMN "accountType" TEXT NOT NULL DEFAULT 'yellow';

-- Update unique constraint on Bid to include accountType
ALTER TABLE "Bid" DROP CONSTRAINT "Bid_auctionId_userId_entityId_key";
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_auctionId_userId_entityId_accountType_key"
  UNIQUE ("auctionId", "userId", "entityId", "accountType");

-- Update unique constraint on BidRecurring to include accountType
ALTER TABLE "BidRecurring" DROP CONSTRAINT "BidRecurring_auctionBaseId_userId_entityId_key";
ALTER TABLE "BidRecurring" ADD CONSTRAINT "BidRecurring_auctionBaseId_userId_entityId_accountType_key"
  UNIQUE ("auctionBaseId", "userId", "entityId", "accountType");

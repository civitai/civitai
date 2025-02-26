DROP INDEX "Auction_type_ecosystem_startAt_key";
DROP INDEX "BidRecurring_type_ecosystem_userId_entityId_key";

ALTER TABLE "Auction" DROP COLUMN "ecosystem",
DROP COLUMN "type",
ADD COLUMN     "auctionBaseId" INTEGER NOT NULL;

ALTER TABLE "BidRecurring" DROP COLUMN "ecosystem",
DROP COLUMN "type",
ADD COLUMN     "auctionBaseId" INTEGER NOT NULL;

CREATE TABLE "AuctionBase" (
    "id" SERIAL NOT NULL,
    "type" "AuctionType" NOT NULL,
    "ecosystem" TEXT,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "minPrice" INTEGER NOT NULL,

    CONSTRAINT "AuctionBase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuctionBase_type_ecosystem_key" ON "AuctionBase"("type", "ecosystem");
CREATE UNIQUE INDEX "AuctionBase_name_key" ON "AuctionBase"("name");
CREATE UNIQUE INDEX "Auction_auctionBaseId_startAt_key" ON "Auction"("auctionBaseId", "startAt");
CREATE UNIQUE INDEX "BidRecurring_auctionBaseId_userId_entityId_key" ON "BidRecurring"("auctionBaseId", "userId", "entityId");

ALTER TABLE "Auction" ADD CONSTRAINT "Auction_auctionBaseId_fkey" FOREIGN KEY ("auctionBaseId") REFERENCES "AuctionBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BidRecurring" ADD CONSTRAINT "BidRecurring_auctionBaseId_fkey" FOREIGN KEY ("auctionBaseId") REFERENCES "AuctionBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TYPE "AuctionType" AS ENUM ('Model', 'Image', 'Collection', 'Article');

CREATE TABLE "Auction" (
    "id" SERIAL NOT NULL,
    "type" "AuctionType" NOT NULL,
    "ecosystem" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "minPrice" INTEGER NOT NULL,

    CONSTRAINT "Auction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Bid" (
    "id" SERIAL NOT NULL,
    "auctionId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "entityId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BidRecurring" (
    "id" SERIAL NOT NULL,
    "type" "AuctionType" NOT NULL,
    "ecosystem" TEXT,
    "userId" INTEGER NOT NULL,
    "entityId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),

    CONSTRAINT "BidRecurring_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Auction_type_ecosystem_startAt_key" ON "Auction"("type", "ecosystem", "startAt");
CREATE UNIQUE INDEX "Bid_auctionId_userId_entityId_key" ON "Bid"("auctionId", "userId", "entityId");
CREATE UNIQUE INDEX "BidRecurring_type_ecosystem_userId_entityId_key" ON "BidRecurring"("type", "ecosystem", "userId", "entityId");

ALTER TABLE "Bid" ADD CONSTRAINT "Bid_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BidRecurring" ADD CONSTRAINT "BidRecurring_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

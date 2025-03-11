ALTER TABLE "AuctionBase" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "slug" TEXT NOT NULL;

CREATE UNIQUE INDEX "AuctionBase_slug_key" ON "AuctionBase"("slug");

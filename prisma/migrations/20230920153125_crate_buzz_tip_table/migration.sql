-- CreateTable
CREATE TABLE "BuzzTip" (
    "entityType" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "toUserId" INTEGER NOT NULL,
    "fromUserId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "BuzzTip_pkey" PRIMARY KEY ("entityType","entityId","fromUserId")
);

-- CreateIndex
CREATE INDEX "BuzzTip_toUserId_idx" ON "BuzzTip"("toUserId");

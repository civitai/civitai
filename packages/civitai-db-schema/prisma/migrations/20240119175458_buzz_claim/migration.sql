-- CreateTable
CREATE TABLE "BuzzClaim" (
    "key" TEXT NOT NULL,
    "transactionIdQuery" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "availableStart" TIMESTAMP(3),
    "availableEnd" TIMESTAMP(3),

    CONSTRAINT "BuzzClaim_pkey" PRIMARY KEY ("key")
);

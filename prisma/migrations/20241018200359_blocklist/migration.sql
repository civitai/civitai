-- CreateTable
CREATE TABLE "Blocklist" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "data" TEXT[],

    CONSTRAINT "Blocklist_pkey" PRIMARY KEY ("id")
);

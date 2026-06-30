-- CreateTable
CREATE TABLE "SearchIndexUpdateQueue" (
    "type" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchIndexUpdateQueue_pkey" PRIMARY KEY ("type","id")
);

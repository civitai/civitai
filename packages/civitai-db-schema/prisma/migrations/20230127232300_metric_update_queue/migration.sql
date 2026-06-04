-- CreateTable
CREATE TABLE "MetricUpdateQueue" (
    "type" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricUpdateQueue_pkey" PRIMARY KEY ("type","id")
);

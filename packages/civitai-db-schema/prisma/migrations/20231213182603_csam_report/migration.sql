-- CreateTable
CREATE TABLE "CsamReport" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportedById" INTEGER NOT NULL,
    "reportSentAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "contentRemovedAt" TIMESTAMP(3),
    "reportId" INTEGER,
    "details" JSONB NOT NULL DEFAULT '{}',
    "images" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "CsamReport_pkey" PRIMARY KEY ("id")
);

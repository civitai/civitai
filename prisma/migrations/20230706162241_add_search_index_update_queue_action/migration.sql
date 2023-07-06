-- AlterTable
ALTER TABLE "SearchIndexUpdateQueue" DROP CONSTRAINT "SearchIndexUpdateQueue_pkey",
ADD COLUMN     "action" TEXT NOT NULL,
ADD CONSTRAINT "SearchIndexUpdateQueue_pkey" PRIMARY KEY ("type", "id", "action");
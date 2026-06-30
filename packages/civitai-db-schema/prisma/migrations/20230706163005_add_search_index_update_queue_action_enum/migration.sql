-- CreateEnum
CREATE TYPE "SearchIndexUpdateQueueAction" AS ENUM ('Update', 'Delete');

-- AlterTable
ALTER TABLE "SearchIndexUpdateQueue" DROP CONSTRAINT "SearchIndexUpdateQueue_pkey",
DROP COLUMN "action",
ADD COLUMN     "action" "SearchIndexUpdateQueueAction" NOT NULL DEFAULT 'Update',
ADD CONSTRAINT "SearchIndexUpdateQueue_pkey" PRIMARY KEY ("type", "id", "action");

BEGIN;
-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "clubPostId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Thread_clubPostId_key" ON "Thread"("clubPostId");

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_clubPostId_fkey" FOREIGN KEY ("clubPostId") REFERENCES "ClubPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
COMMIT;

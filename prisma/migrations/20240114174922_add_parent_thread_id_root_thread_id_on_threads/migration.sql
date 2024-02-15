-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "parentThreadId" INTEGER,
ADD COLUMN     "rootThreadId" INTEGER;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_parentThreadId_fkey" FOREIGN KEY ("parentThreadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_rootThreadId_fkey" FOREIGN KEY ("rootThreadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

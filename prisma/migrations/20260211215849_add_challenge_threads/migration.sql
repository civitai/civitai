-- AlterTable
ALTER TABLE "Thread" ADD COLUMN "challengeId" INTEGER;

-- CreateIndex (unique constraint)
CREATE UNIQUE INDEX "Thread_challengeId_key" ON "Thread"("challengeId");

-- CreateIndex (hash index for lookups)
CREATE INDEX "Thread_challengeId_idx" ON "Thread" USING HASH ("challengeId");

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

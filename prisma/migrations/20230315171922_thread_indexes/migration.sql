-- CreateIndex
CREATE INDEX "Thread_reviewId_idx" ON "Thread" USING HASH ("reviewId");

-- CreateIndex
CREATE INDEX "Thread_postId_idx" ON "Thread" USING HASH ("postId");

-- CreateIndex
CREATE INDEX "Thread_questionId_idx" ON "Thread" USING HASH ("questionId");

-- CreateIndex
CREATE INDEX "Thread_imageId_idx" ON "Thread" USING HASH ("imageId");

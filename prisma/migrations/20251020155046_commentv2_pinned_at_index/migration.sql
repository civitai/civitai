-- Index for pinned comments (Remember to run concurrently in production)
CREATE INDEX idx_commentv2_thread_pinned ON "CommentV2"("threadId", "pinnedAt" DESC) WHERE "pinnedAt" IS NOT NULL;
-- CREATE INDEX CONCURRENTLY idx_commentv2_thread_pinned ON "CommentV2"("threadId", "pinnedAt" DESC) WHERE "pinnedAt" IS NOT NULL;

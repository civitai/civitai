-- Per-thread notification mute for CommentsV2. New table only, no backfill: every
-- thread starts unmuted, and an absent row means "notify me" for every existing user.
CREATE TABLE "ThreadMute" (
    "userId" INTEGER NOT NULL,
    "threadId" INTEGER NOT NULL,
    "mutedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadMute_pkey" PRIMARY KEY ("userId","threadId")
);

-- The PK's LEADING column is what the suppression check uses. Measured plan: an Index
-- Only Scan with Index Cond on "userId" alone, feeding a join against the walked thread
-- chain -- so the cost is O(rows this user has muted), not O(1). It is cheap in practice
-- because a user with no mutes yields an empty side and the chain is never walked at all,
-- but that short-circuit is a planner choice, not a guarantee. Keep userId leading.

-- For the thread side of the cascade, which has no other index to find its rows by. The
-- suppression never uses this one.
CREATE INDEX "ThreadMute_threadId_idx" ON "ThreadMute"("threadId");

ALTER TABLE "ThreadMute" ADD CONSTRAINT "ThreadMute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThreadMute" ADD CONSTRAINT "ThreadMute_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-thread notification mute for CommentsV2. New table only, no backfill: every
-- thread starts unmuted, and an absent row means "notify me" for every existing user.
CREATE TABLE "ThreadMute" (
    "userId" INTEGER NOT NULL,
    "threadId" INTEGER NOT NULL,
    "mutedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadMute_pkey" PRIMARY KEY ("userId","threadId")
);

-- The suppression check in every comment notification processor is an exact
-- primary-key lookup on (userId, threadId), which the PK above serves. Keep it that
-- shape: `notBlockedBetween` measured 2.5x slower once the planner was given a
-- secondary index to prefer instead.

-- For the thread side of the cascade, which has no other index to find its rows by.
CREATE INDEX "ThreadMute_threadId_idx" ON "ThreadMute"("threadId");

ALTER TABLE "ThreadMute" ADD CONSTRAINT "ThreadMute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThreadMute" ADD CONSTRAINT "ThreadMute_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

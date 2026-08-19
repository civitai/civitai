-- Creator announcements (CU 868ktjte1).
-- Applied by hand, like every migration here.

ALTER TABLE "Announcement"
  ADD COLUMN "userId" INTEGER,
  ADD COLUMN "coverId" INTEGER,
  ADD COLUMN "profileOnly" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Announcement"
  ADD CONSTRAINT "Announcement_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Announcement_coverId_fkey" FOREIGN KEY ("coverId")
    REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Serves both the author's own listing and the follower fan-out.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Announcement_userId_startsAt_idx"
  ON "Announcement"("userId", "startsAt");

CREATE TABLE "UserAnnouncementMute" (
  "userId" INTEGER NOT NULL,
  "creatorId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserAnnouncementMute_pkey" PRIMARY KEY ("userId", "creatorId")
);

ALTER TABLE "UserAnnouncementMute"
  ADD CONSTRAINT "UserAnnouncementMute_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "UserAnnouncementMute_creatorId_fkey" FOREIGN KEY ("creatorId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The send path anti-joins by creator.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "UserAnnouncementMute_creatorId_idx"
  ON "UserAnnouncementMute"("creatorId");

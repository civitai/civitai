-- Creator announcements (CU 868ktjte1).
--
-- Applied by hand, like every migration here. 🔴 Run it with ON_ERROR_STOP:
--   psql -v ON_ERROR_STOP=1 -f migration.sql
-- Without it psql continues past a failure, and a timed-out FK or an INVALID index leaves
-- the app running with the constraint simply absent.

-- ADD CONSTRAINT takes SHARE ROW EXCLUSIVE on the REFERENCED table, which conflicts with
-- every write to Image and User. Without a timeout one long transaction stalls all of
-- them behind this. Same pattern as 20260702130000_imagereport_imageid_fk.
SET lock_timeout = '5s';

ALTER TABLE "Announcement"
  ADD COLUMN "userId" INTEGER,
  ADD COLUMN "coverId" INTEGER,
  ADD COLUMN "profileOnly" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Announcement"
  ADD CONSTRAINT "Announcement_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Announcement_coverId_fkey" FOREIGN KEY ("coverId")
    REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Serves both the author's own listing and the follower fan-out. CONCURRENTLY here
-- because Announcement already exists; if it is cancelled the index is left INVALID and
-- must be dropped before retrying.
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

-- The send path anti-joins by creator. Plain CREATE INDEX: the table was created three
-- statements ago and is empty, so CONCURRENTLY only adds a way to end up INVALID.
CREATE INDEX "UserAnnouncementMute_creatorId_idx"
  ON "UserAnnouncementMute"("creatorId");

CREATE TABLE "AnnouncementSpend" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "announcementId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "AnnouncementSpend"
  ADD CONSTRAINT "AnnouncementSpend_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AnnouncementSpend_announcementId_fkey" FOREIGN KEY ("announcementId")
    REFERENCES "Announcement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The allowance counts spends in a rolling window per creator.
CREATE INDEX "AnnouncementSpend_userId_createdAt_idx"
  ON "AnnouncementSpend"("userId", "createdAt");

-- The FK is ON DELETE SET NULL, so every announcement delete looks for spends pointing at
-- it. Unique as well as indexed: one announcement can only ever have spent one slot, which
-- is the constraint that stops a replica-lagged second save charging the same row twice.
CREATE UNIQUE INDEX "AnnouncementSpend_announcementId_key"
  ON "AnnouncementSpend"("announcementId")
  WHERE "announcementId" IS NOT NULL;

RESET lock_timeout;

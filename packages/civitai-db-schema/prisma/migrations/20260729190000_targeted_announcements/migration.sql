-- Targeted announcements: per-announcement allowlist of user ids.
-- An announcement with rows here is only shown to those users; announcements
-- without rows keep the current show-everyone behavior.
CREATE TABLE "AnnouncementUser" (
    "announcementId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "AnnouncementUser_pkey" PRIMARY KEY ("userId", "announcementId")
);

-- PK ("userId", "announcementId") serves the hot read path: membership lookup for
-- one user against the small set of currently-live targeted announcements.
-- This index serves the write path: replacing/deleting an announcement's target set.
CREATE INDEX "AnnouncementUser_announcementId_idx" ON "AnnouncementUser"("announcementId");

ALTER TABLE "AnnouncementUser"
    ADD CONSTRAINT "AnnouncementUser_announcementId_fkey"
    FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnnouncementUser"
    ADD CONSTRAINT "AnnouncementUser_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

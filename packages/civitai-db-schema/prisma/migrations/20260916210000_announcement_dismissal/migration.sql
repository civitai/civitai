-- NOT YET APPLIED. Additive and order-independent: a new table nothing reads until the deploy that
-- ships with it, and no enum, so none of the deploy-first hazard that an ALTER TYPE carries. Safe
-- to apply before or after the deploy.
--
-- Why a table rather than an array on User.settings: settings is serialised into the HTML of every
-- logged-in SSR render, and a dismissal list grows for the life of the account. Here the growth is
-- invisible to the render path, because the read is scoped to currently-active announcements.
--
-- Deliberately NOT a column on AnnouncementUser, which is the targeting table: getAnnouncements
-- derives `targeted` from the presence of a row there, and a targeted announcement is then shown
-- ONLY to users who have one. Dismissal rows in that table would show each announcement exclusively
-- to the people who dismissed it.

CREATE TABLE IF NOT EXISTS "AnnouncementDismissal" (
    "announcementId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementDismissal_pkey" PRIMARY KEY ("userId","announcementId")
);

-- Serves the cleanup delete (by announcement) and "how many users dismissed N". The PK already
-- covers the per-user read.
CREATE INDEX IF NOT EXISTS "AnnouncementDismissal_announcementId_idx" ON "AnnouncementDismissal"("announcementId");

ALTER TABLE "AnnouncementDismissal"
    ADD CONSTRAINT "AnnouncementDismissal_announcementId_fkey"
    FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnnouncementDismissal"
    ADD CONSTRAINT "AnnouncementDismissal_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

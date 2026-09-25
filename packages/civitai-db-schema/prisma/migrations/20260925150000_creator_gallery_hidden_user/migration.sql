-- A creator's gallery hidden-users list, applied to every gallery the creator owns
-- (Model and Model3D), on top of each model's own `gallerySettings.users`.
--
-- No foreign keys to "User": adding one locks "User" while it validates, and that lock queues
-- behind long transactions on the busiest table in the database. Rows for deleted users are
-- skipped by joining "User" at read time.
CREATE TABLE IF NOT EXISTS "CreatorGalleryHiddenUser" (
  "creatorId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorGalleryHiddenUser_pkey" PRIMARY KEY ("creatorId", "userId")
);

CREATE INDEX IF NOT EXISTS "CreatorGalleryHiddenUser_userId_idx" ON "CreatorGalleryHiddenUser" ("userId");

-- Version showcase overlay: a creator's edits to one model version's showcase on one site. A row
-- either features a community image (source 'Community'), or positions or hides one of the owner's
-- own images (source 'Owner'). A version and site with no rows keeps today's showcase, so nothing
-- is backfilled.
--
-- MANUAL APPLY. Migrations are not auto-applied to the main database: this file is committed for
-- history and a human runs the SQL below on each environment (preview / dev, then production).
-- CI and deploys do not run it.
--
-- DEPLOY ORDER: either order is safe. Nothing reads or writes the table until the read and write
-- paths ship behind the `model-version-showcase` flag, and those must not merge before this is
-- applied in production.
--
-- NO FOREIGN KEYS, on purpose. A foreign key to "Image" would add a check to every image delete
-- and take a lock on "Image" to create, and that table is too hot to constrain. A row whose image
-- or version is gone matches nothing when the showcase is read.
--
-- LOCKING / SIZE: a new, empty table. Nothing else is locked.
--
-- ROLLBACK: `DROP TABLE IF EXISTS "ModelVersionShowcaseItem";` (discards any creator edits).
--
-- Verify by reading back the table, its two CHECK constraints and its index
-- (`\d "ModelVersionShowcaseItem"`).
BEGIN;

CREATE TABLE IF NOT EXISTS "ModelVersionShowcaseItem" (
  "modelVersionId" INTEGER NOT NULL,
  "site" TEXT NOT NULL,
  "imageId" INTEGER NOT NULL,
  "source" TEXT NOT NULL,
  "position" SMALLINT,
  "excluded" BOOLEAN NOT NULL DEFAULT false,
  "addedById" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ModelVersionShowcaseItem_pkey" PRIMARY KEY ("modelVersionId", "site", "imageId"),
  CONSTRAINT "ModelVersionShowcaseItem_site_check" CHECK ("site" IN ('com', 'red')),
  CONSTRAINT "ModelVersionShowcaseItem_source_check" CHECK (
    "source" IN ('Owner', 'Community') AND NOT ("excluded" AND "source" = 'Community')
  )
);

-- Busts from image events, and a contributor removing their image everywhere.
CREATE INDEX IF NOT EXISTS "ModelVersionShowcaseItem_imageId_idx"
  ON "ModelVersionShowcaseItem" ("imageId");

COMMIT;

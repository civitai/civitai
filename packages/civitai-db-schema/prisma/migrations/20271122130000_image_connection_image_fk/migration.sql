\set ON_ERROR_STOP on
-- HAND-APPLIED with psql on a direct primary connection (not the transaction pooler). Restores the
-- foreign key schema.full.prisma declares on "ImageConnection"."imageId" (onDelete: Cascade), which the
-- database lacks: a deleted image left its connections behind, and a Prisma read that includes the
-- connection's image then fails on the required relation.
--
-- Image deletes already remove their connections (content-deletion.db.ts), so the cascade only does
-- what the app does today. NOT VALID skips the scan of existing rows; 20271122130100 validates them.
-- Never dry-run this file inside BEGIN ... ROLLBACK: it commits its own transactions. On a dev clone, run
-- each block between BEGIN; and ROLLBACK; instead.

-- 1. The orphans: connections whose image is gone. They name no media, so nothing is lost.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10min';
DELETE FROM "ImageConnection" ic
WHERE NOT EXISTS (SELECT 1 FROM "Image" i WHERE i.id = ic."imageId");
COMMIT;

-- 2. The key. ADD CONSTRAINT ... NOT VALID takes SHARE ROW EXCLUSIVE on both tables for a catalogue
--    update, with no scan. On a lock timeout nothing changes: retry off-peak.
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE "ImageConnection" ADD CONSTRAINT "ImageConnection_imageId_fkey"
  FOREIGN KEY ("imageId") REFERENCES "Image"(id) ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
COMMIT;

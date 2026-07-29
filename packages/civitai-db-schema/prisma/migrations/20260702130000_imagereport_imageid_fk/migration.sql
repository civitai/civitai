-- Repair ImageReport drift + enforce the missing imageId FK.
--
-- prisma/schema.prisma declares `ImageReport.image ... onDelete: Cascade`, but
-- production only ever had `ImageReport_reportId_fkey` — the imageId FK was
-- never applied. So image deletes leave dangling ImageReport rows, and
-- `getImageModerationCounts` (which does not join Image) counts those orphans,
-- inflating the moderator "Reported" counter above what the queue can show.
--
-- NOTE: applied MANUALLY (this repo does NOT use `prisma migrate deploy`).
-- Run top to bottom; steps a) and b) must precede c) or the ADD CONSTRAINT
-- would fail validation on the existing orphan rows.

-- a) Purge orphaned reports. A Report with an ImageReport child is exclusively
--    an image report, so once the image is gone the whole report is dead.
--    Deleting the parent Report cascades to ImageReport via
--    ImageReport_reportId_fkey (ON DELETE CASCADE), clearing both in one pass.
DELETE FROM "Report" r
USING "ImageReport" ir
WHERE ir."reportId" = r.id
  AND NOT EXISTS (SELECT 1 FROM "Image" i WHERE i.id = ir."imageId");

-- b) Belt-and-suspenders: remove any ImageReport rows whose parent Report was
--    already gone (so step a) couldn't reach them via the join).
DELETE FROM "ImageReport" ir
WHERE NOT EXISTS (SELECT 1 FROM "Image" i WHERE i.id = ir."imageId");

-- c) Add the FK. Two-step (NOT VALID, then VALIDATE) so we never hold an
--    ACCESS EXCLUSIVE lock while scanning a hot, large table: NOT VALID takes
--    only a brief lock, and VALIDATE runs under SHARE UPDATE EXCLUSIVE, which
--    does not block concurrent reads/writes.
ALTER TABLE "ImageReport"
  ADD CONSTRAINT "ImageReport_imageId_fkey"
  FOREIGN KEY ("imageId") REFERENCES "Image"(id) ON DELETE CASCADE ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "ImageReport" VALIDATE CONSTRAINT "ImageReport_imageId_fkey";

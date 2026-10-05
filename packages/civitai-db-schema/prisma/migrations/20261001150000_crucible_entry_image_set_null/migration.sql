-- Idempotent: applied by hand, possibly more than once.
--
-- An entry used to be deleted with its image, taking its entry fee out of the prize pool and out of
-- reach of a cancel's refund. It now stays, with no image: it can't be seen or placed, but its fee
-- still counts.
--
-- 🔴 APPLY BEFORE THE CODE DEPLOYS and deploy promptly: the previous build reads "imageId" as
-- required, so a row nulled by an image deletion in between would fail to load there.

ALTER TABLE "CrucibleEntry" ALTER COLUMN "imageId" DROP NOT NULL;

ALTER TABLE "CrucibleEntry" DROP CONSTRAINT IF EXISTS "CrucibleEntry_imageId_fkey";
ALTER TABLE "CrucibleEntry" ADD CONSTRAINT "CrucibleEntry_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Image" ADD COLUMN "needsReview_new" TEXT;
UPDATE "Image" SET "needsReview_new" = 'minor' WHERE "needsReview" = true;

ALTER TABLE "Image" DROP COLUMN "needsReview";
ALTER TABLE "Image" RENAME COLUMN "needsReview_new" TO "needsReview";

-- Mark existing nsfw images with poi as poi...
UPDATE "Image" SET "needsReview" = 'poi'
WHERE id IN (
	SELECT DISTINCT
	  ir."imageId"
	FROM "ImageResource" ir
	JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id
	JOIN "Model" m ON m.id = mv."modelId"
	JOIN "Image" i ON ir."imageId" = i.id AND i.nsfw != 'None'
	WHERE m.poi
);

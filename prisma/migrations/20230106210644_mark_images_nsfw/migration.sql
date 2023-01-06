-- This is an empty migration.
WITH nsfw_images AS (
	SELECT
	  im."imageId"
	FROM "ImagesOnModels" im
	JOIN "ModelVersion" mv ON mv.id = im."modelVersionId"
	JOIN "Model" m ON m.id = mv."modelId"
	WHERE m.nsfw = true

	UNION

	SELECT
	  ir."imageId"
	FROM "ImagesOnReviews" ir
	JOIN "Review" r ON r.id = ir."reviewId"
	WHERE r.nsfw = true
)
UPDATE "Image" i SET nsfw = true
WHERE EXISTS (SELECT 1 FROM nsfw_images n WHERE "imageId" = i.id)
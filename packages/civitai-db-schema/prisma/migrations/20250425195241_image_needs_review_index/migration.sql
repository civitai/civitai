DROP INDEX IF EXISTS "Image_nsfw";

DROP INDEX IF EXISTS "Image_needsReview_index";

CREATE INDEX "Image_needsReview_index" ON "Image"("needsReview") WHERE "needsReview" IS NOT NULL;
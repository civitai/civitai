DROP INDEX "Image_nsfw";

DROP INDEX "Image_needsReview_index";

CREATE INDEX "Image_needsReview_index" ON "Image"("needsReview") WHERE "needsReview" IS NOT NULL;
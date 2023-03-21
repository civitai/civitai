-- DropIndex
DROP INDEX "TagsOnImage_automated_idx";

-- CreateIndex
CREATE INDEX "TagsOnImage_automated_idx" ON "TagsOnImage" USING HASH ("automated");

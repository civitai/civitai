

-- CreateTable
CREATE TABLE "ShadowTagsOnImage" (
    "imageId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,
    "confidence" INTEGER NOT NULL,

    CONSTRAINT "ShadowTagsOnImage_pkey" PRIMARY KEY ("imageId","tagId")
);

-- CreateIndex
CREATE INDEX "ShadowTagsOnImage_tagId_idx" ON "ShadowTagsOnImage"("tagId");


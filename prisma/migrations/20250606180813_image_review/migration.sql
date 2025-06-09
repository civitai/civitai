

-- CreateTable
CREATE TABLE "ImageForReview" (
    "imageId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "ImageForReview_pkey" PRIMARY KEY ("imageId")
);

-- CreateTable
CREATE TABLE "ImageTagForReview" (
    "imageId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,

    CONSTRAINT "ImageTagForReview_pkey" PRIMARY KEY ("imageId","tagId")
);

-- CreateIndex
CREATE INDEX "ImageTagForReview_tagId_idx" ON "ImageTagForReview"("tagId");

-- AddForeignKey
ALTER TABLE "ImageForReview" ADD CONSTRAINT "ImageForReview_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageTagForReview" ADD CONSTRAINT "ImageTagForReview_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

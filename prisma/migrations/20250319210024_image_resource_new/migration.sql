

-- CreateTable
CREATE TABLE "ImageResourceNew" (
    "imageId" INTEGER NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "strength" INTEGER,
    "detected" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ImageResourceNew_pkey" PRIMARY KEY ("imageId","modelVersionId")
);

-- CreateIndex
CREATE INDEX "ImageResourceNew_modelVersionId_idx" ON "ImageResourceNew"("modelVersionId");


-- AddForeignKey
ALTER TABLE "ImageResourceNew" ADD CONSTRAINT "ImageResourceNew_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageResourceNew" ADD CONSTRAINT "ImageResourceNew_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
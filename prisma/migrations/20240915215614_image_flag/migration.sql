

-- CreateTable
CREATE TABLE "ModelFlag" (
    "modelId" INTEGER NOT NULL,
    "nameNsfw" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ModelFlag_pkey" PRIMARY KEY ("modelId")
);

-- CreateTable
CREATE TABLE "ImageFlag" (
    "imageId" INTEGER NOT NULL,
    "promptNsfw" BOOLEAN NOT NULL DEFAULT false,
    "resourcesNsfw" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ImageFlag_pkey" PRIMARY KEY ("imageId")
);

-- AddForeignKey
ALTER TABLE "ModelFlag" ADD CONSTRAINT "ModelFlag_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageFlag" ADD CONSTRAINT "ImageFlag_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

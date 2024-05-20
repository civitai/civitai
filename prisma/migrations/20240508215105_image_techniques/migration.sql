
-- CreateEnum
CREATE TYPE "TechniqueType" AS ENUM ('Image', 'Video');

-- CreateTable
CREATE TABLE "Technique" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "type" "TechniqueType" NOT NULL,

    CONSTRAINT "Technique_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageTechnique" (
    "imageId" INTEGER NOT NULL,
    "techniqueId" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageTechnique_pkey" PRIMARY KEY ("imageId","techniqueId")
);

-- CreateIndex
CREATE INDEX "ImageTechnique_techniqueId_idx" ON "ImageTechnique"("techniqueId");

-- AddForeignKey
ALTER TABLE "ImageTechnique" ADD CONSTRAINT "ImageTechnique_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageTechnique" ADD CONSTRAINT "ImageTechnique_techniqueId_fkey" FOREIGN KEY ("techniqueId") REFERENCES "Technique"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "Technique" ("name", "type")
VALUES
  ('txt2img', 'Image'),
  ('img2img', 'Image'),
  ('inpainting', 'Image'),
  ('workflow', 'Image'),
  ('vid2vid', 'Video'),
  ('txt2vid', 'Video'),
  ('img2vid', 'Video')


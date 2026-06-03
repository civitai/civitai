
-- CreateEnum
CREATE TYPE "ImageEngagementType" AS ENUM ('Favorite', 'Hide');

-- CreateTable
CREATE TABLE "ImageEngagement" (
    "userId" INTEGER NOT NULL,
    "imageId" INTEGER NOT NULL,
    "type" "ImageEngagementType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageEngagement_pkey" PRIMARY KEY ("userId","imageId")
);


-- CreateIndex
CREATE INDEX "ImageEngagement_imageId_idx" ON "ImageEngagement"("imageId");

-- AddForeignKey
ALTER TABLE "ImageEngagement" ADD CONSTRAINT "ImageEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageEngagement" ADD CONSTRAINT "ImageEngagement_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageRatingRequest" ADD CONSTRAINT "ImageRatingRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageRatingRequest" ADD CONSTRAINT "ImageRatingRequest_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

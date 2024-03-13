


-- CreateIndex
CREATE UNIQUE INDEX "Article_coverId_key" ON "Article"("coverId");

-- AddForeignKey
ALTER TABLE "Article"
  ADD CONSTRAINT "Article_coverId_fkey" FOREIGN KEY ("coverId") REFERENCES "Image"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


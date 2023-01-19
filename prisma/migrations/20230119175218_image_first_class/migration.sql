-- CreateTable
CREATE TABLE "ImageReport" (
    "imageId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "ImageComment" (
    "imageId" INTEGER NOT NULL,
    "commentId" INTEGER NOT NULL,

    CONSTRAINT "ImageComment_pkey" PRIMARY KEY ("imageId","commentId")
);

-- CreateTable
CREATE TABLE "ImageReaction" (
    "id" SERIAL NOT NULL,
    "imageId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "reaction" "ReviewReactions" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImageReport_reportId_key" ON "ImageReport"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "ImageComment_commentId_key" ON "ImageComment"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "ImageReaction_imageId_userId_reaction_key" ON "ImageReaction"("imageId", "userId", "reaction");

-- AddForeignKey
ALTER TABLE "ImageReport" ADD CONSTRAINT "ImageReport_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageReport" ADD CONSTRAINT "ImageReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageComment" ADD CONSTRAINT "ImageComment_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageComment" ADD CONSTRAINT "ImageComment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "CommentV2"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageReaction" ADD CONSTRAINT "ImageReaction_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageReaction" ADD CONSTRAINT "ImageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

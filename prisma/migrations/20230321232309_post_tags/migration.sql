-- AlterTable
ALTER TABLE "TagsOnPost" ADD COLUMN     "confidence" INTEGER,
ADD COLUMN     "disabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TagsOnPostVote" (
    "postId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "vote" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagsOnPostVote_pkey" PRIMARY KEY ("tagId","postId","userId")
);

-- CreateIndex
CREATE INDEX "TagsOnPostVote_postId_idx" ON "TagsOnPostVote" USING HASH ("postId");

-- CreateIndex
CREATE INDEX "TagsOnPostVote_userId_idx" ON "TagsOnPostVote" USING HASH ("userId");

-- AddForeignKey
ALTER TABLE "TagsOnPostVote" ADD CONSTRAINT "TagsOnPostVote_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnPostVote" ADD CONSTRAINT "TagsOnPostVote_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnPostVote" ADD CONSTRAINT "TagsOnPostVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE VIEW "PostImageTag" AS
SELECT DISTINCT
  i."postId" post_id,
  toi."tagId" tag_id
FROM "TagsOnImage" toi
JOIN "Image" i ON i.id = toi."imageId"
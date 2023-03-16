-- CreateTable
CREATE TABLE "TagsOnImageVote" (
    "imageId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "vote" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagsOnImageVote_pkey" PRIMARY KEY ("tagId","imageId","userId")
);

-- CreateIndex
CREATE INDEX "TagsOnImageVote_imageId_idx" ON "TagsOnImageVote" USING HASH ("imageId");

-- CreateIndex
CREATE INDEX "TagsOnImageVote_userId_idx" ON "TagsOnImageVote" USING HASH ("userId");

-- AddForeignKey
ALTER TABLE "TagsOnImageVote" ADD CONSTRAINT "TagsOnImageVote_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnImageVote" ADD CONSTRAINT "TagsOnImageVote_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnImageVote" ADD CONSTRAINT "TagsOnImageVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add ImageTag View
CREATE OR REPLACE VIEW "ImageTag" AS
WITH image_tags AS (
  SELECT
	  "imageId",
	  "tagId",
	  automated,
	  confidence,
		0 "upVotes",
		0 "downVotes"
	FROM "TagsOnImage" toi

	UNION

	SELECT
	  "imageId",
	  "tagId",
	  FALSE "automated",
	  NULL "confidence",
	  SUM(IIF(vote > 0, 1, 0)) "upVotes",
	  SUM(IIF(vote < 0, 1, 0)) "downVotes"
	FROM "TagsOnImageVote"
	GROUP BY "tagId", "imageId"
)
SELECT
  it.*,
  t.name "tagName",
  t.type "tagType"
FROM image_tags it
JOIN "Tag" t ON t.id = it."tagId"
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

CREATE OR REPLACE VIEW "PostTag" AS
WITH post_tags AS (
  SELECT
	  "postId",
	  "tagId",
	  5 "score",
		0 "upVotes",
		0 "downVotes"
	FROM "TagsOnPost" toi
	WHERE NOT disabled

	UNION

	SELECT
	  "postId",
	  "tagId",
		SUM(vote) "score",
	  SUM(IIF(vote > 0, 1, 0)) "upVotes",
	  SUM(IIF(vote < 0, 1, 0)) "downVotes"
	FROM "TagsOnPostVote"
	GROUP BY "tagId", "postId"
)
SELECT
  pt."postId",
  pt."tagId",
  SUM(score) "score",
  MAX("upVotes") "upVotes",
  MAX("downVotes") "downVotes",
  t.name "tagName",
  t.type "tagType"
FROM post_tags pt
JOIN "Tag" t ON t.id = pt."tagId"
GROUP BY pt."postId", pt."tagId", t.name, t.type;
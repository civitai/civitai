-- CreateTable
CREATE TABLE "TagsOnModelsVote" (
    "modelId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "vote" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagsOnModelsVote_pkey" PRIMARY KEY ("tagId","modelId","userId")
);

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
CREATE INDEX "TagsOnModelsVote_modelId_idx" ON "TagsOnModelsVote" USING HASH ("modelId");

-- CreateIndex
CREATE INDEX "TagsOnModelsVote_userId_idx" ON "TagsOnModelsVote" USING HASH ("userId");

-- CreateIndex
CREATE INDEX "TagsOnImageVote_imageId_idx" ON "TagsOnImageVote" USING HASH ("imageId");

-- CreateIndex
CREATE INDEX "TagsOnImageVote_userId_idx" ON "TagsOnImageVote" USING HASH ("userId");

-- AddForeignKey
ALTER TABLE "TagsOnModelsVote" ADD CONSTRAINT "TagsOnModelsVote_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnModelsVote" ADD CONSTRAINT "TagsOnModelsVote_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnModelsVote" ADD CONSTRAINT "TagsOnModelsVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnImageVote" ADD CONSTRAINT "TagsOnImageVote_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnImageVote" ADD CONSTRAINT "TagsOnImageVote_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnImageVote" ADD CONSTRAINT "TagsOnImageVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add ModelTag view
CREATE OR REPLACE VIEW "ModelTag" AS
WITH model_tags AS (
  SELECT
	  "modelId",
	  "tagId",
	  5 "score", -- Weight of creator selection
		1 "upVotes",
		0 "downVotes"
	FROM "TagsOnModels"

	UNION

	SELECT
	  "modelId",
	  "tagId",
	  SUM(vote) "score",
	  SUM(IIF(vote > 0, 1, 0)) "upVotes",
	  SUM(IIF(vote < 0, 1, 0)) "downVotes"
	FROM "TagsOnModelsVote"
	GROUP BY "tagId", "modelId"
)
SELECT
  mt."modelId",
  mt."tagId",
  SUM(mt.score) "score",
  SUM("upVotes") "upVotes",
  SUM("downVotes") "downVotes",
  t.name "tagName",
  t.type "tagType"
FROM model_tags mt
JOIN "Tag" t ON t.id = mt."tagId"
GROUP BY mt."modelId", mt."tagId", t.name, t.type;

-- Add ImageTag View
CREATE OR REPLACE VIEW "ImageTag" AS
WITH image_tags AS (
  SELECT
	  "imageId",
	  "tagId",
	  automated,
	  confidence,
	  5 * confidence/100 "score",
		0 "upVotes",
		0 "downVotes"
	FROM "TagsOnImage" toi

	UNION

	SELECT
	  "imageId",
	  "tagId",
	  FALSE "automated",
	  0 "confidence",
		SUM(vote) "score",
	  SUM(IIF(vote > 0, 1, 0)) "upVotes",
	  SUM(IIF(vote < 0, 1, 0)) "downVotes"
	FROM "TagsOnImageVote"
	GROUP BY "tagId", "imageId"
)
SELECT
  it."imageId",
  it."tagId",
  BOOL_OR(it.automated) "automated",
  MAX(it.confidence) "confidence",
  SUM(score) "score",
  MAX("upVotes") "upVotes",
  MAX("downVotes") "downVotes",
  t.name "tagName",
  t.type "tagType"
FROM image_tags it
JOIN "Tag" t ON t.id = it."tagId"
GROUP BY it."imageId", it."tagId", t.name, t.type;
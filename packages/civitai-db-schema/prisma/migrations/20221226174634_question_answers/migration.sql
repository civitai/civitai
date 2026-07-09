-- CreateTable
CREATE TABLE "Question" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "selectedAnswerId" INTEGER,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionMetric" (
    "questionId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "heartCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "answerCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuestionMetric_pkey" PRIMARY KEY ("questionId","timeframe")
);

-- CreateTable
CREATE TABLE "Answer" (
    "id" SERIAL NOT NULL,
    "questionId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnswerVote" (
    "answerId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "vote" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnswerVote_pkey" PRIMARY KEY ("answerId","userId")
);

-- CreateTable
CREATE TABLE "AnswerMetric" (
    "answerId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "checkCount" INTEGER NOT NULL,
    "crossCount" INTEGER NOT NULL,
    "heartCount" INTEGER NOT NULL,
    "commentCount" INTEGER NOT NULL,

    CONSTRAINT "AnswerMetric_pkey" PRIMARY KEY ("answerId","timeframe")
);

-- CreateTable
CREATE TABLE "CommentV2" (
    "id" SERIAL NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nsfw" BOOLEAN NOT NULL DEFAULT false,
    "tosViolation" BOOLEAN NOT NULL DEFAULT false,
    "parentId" INTEGER,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "CommentV2_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionComment" (
    "questionId" INTEGER NOT NULL,
    "commentId" INTEGER NOT NULL,

    CONSTRAINT "QuestionComment_pkey" PRIMARY KEY ("questionId","commentId")
);

-- CreateTable
CREATE TABLE "AnswerComment" (
    "answerId" INTEGER NOT NULL,
    "commentId" INTEGER NOT NULL,

    CONSTRAINT "AnswerComment_pkey" PRIMARY KEY ("answerId","commentId")
);

-- CreateTable
CREATE TABLE "TagsOnQuestions" (
    "questionId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,

    CONSTRAINT "TagsOnQuestions_pkey" PRIMARY KEY ("tagId","questionId")
);

-- CreateTable
CREATE TABLE "QuestionReaction" (
    "id" SERIAL NOT NULL,
    "questionId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "reaction" "ReviewReactions" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnswerReaction" (
    "id" SERIAL NOT NULL,
    "answerId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "reaction" "ReviewReactions" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnswerReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentV2Reaction" (
    "id" SERIAL NOT NULL,
    "commentId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "reaction" "ReviewReactions" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommentV2Reaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Question_selectedAnswerId_key" ON "Question"("selectedAnswerId");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionComment_commentId_key" ON "QuestionComment"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "AnswerComment_commentId_key" ON "AnswerComment"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionReaction_questionId_userId_reaction_key" ON "QuestionReaction"("questionId", "userId", "reaction");

-- CreateIndex
CREATE UNIQUE INDEX "AnswerReaction_answerId_userId_reaction_key" ON "AnswerReaction"("answerId", "userId", "reaction");

-- CreateIndex
CREATE UNIQUE INDEX "CommentV2Reaction_commentId_userId_reaction_key" ON "CommentV2Reaction"("commentId", "userId", "reaction");

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_selectedAnswerId_fkey" FOREIGN KEY ("selectedAnswerId") REFERENCES "Answer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionMetric" ADD CONSTRAINT "QuestionMetric_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerVote" ADD CONSTRAINT "AnswerVote_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerVote" ADD CONSTRAINT "AnswerVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerMetric" ADD CONSTRAINT "AnswerMetric_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentV2" ADD CONSTRAINT "CommentV2_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CommentV2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentV2" ADD CONSTRAINT "CommentV2_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionComment" ADD CONSTRAINT "QuestionComment_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionComment" ADD CONSTRAINT "QuestionComment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "CommentV2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerComment" ADD CONSTRAINT "AnswerComment_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerComment" ADD CONSTRAINT "AnswerComment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "CommentV2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnQuestions" ADD CONSTRAINT "TagsOnQuestions_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnQuestions" ADD CONSTRAINT "TagsOnQuestions_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionReaction" ADD CONSTRAINT "QuestionReaction_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionReaction" ADD CONSTRAINT "QuestionReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerReaction" ADD CONSTRAINT "AnswerReaction_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerReaction" ADD CONSTRAINT "AnswerReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentV2Reaction" ADD CONSTRAINT "CommentV2Reaction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "CommentV2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentV2Reaction" ADD CONSTRAINT "CommentV2Reaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add Views
CREATE VIEW "AnswerRank" AS
SELECT
	t."answerId",
	MAX(IIF(t.timeframe = 'Day', t."heartCount", NULL)) AS "heartCountDay",
	MAX(IIF(t.timeframe = 'Day', t."heartCountRank", NULL)) AS "heartCountDayRank",
	MAX(IIF(t.timeframe = 'Week', t."heartCount", NULL)) AS "heartCountWeek",
	MAX(IIF(t.timeframe = 'Week', t."heartCountRank", NULL)) AS "heartCountWeekRank",
	MAX(IIF(t.timeframe = 'Month', t."heartCount", NULL)) AS "heartCountMonth",
	MAX(IIF(t.timeframe = 'Month', t."heartCountRank", NULL)) AS "heartCountMonthRank",
	MAX(IIF(t.timeframe = 'Year', t."heartCount", NULL)) AS "heartCountYear",
	MAX(IIF(t.timeframe = 'Year', t."heartCountRank", NULL)) AS "heartCountYearRank",
	MAX(IIF(t.timeframe = 'AllTime', t."heartCount", NULL)) AS "heartCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime', t."heartCountRank", NULL)) AS "heartCountAllTimeRank",
	MAX(IIF(t.timeframe = 'Day', t."commentCount", NULL)) AS "commentCountDay",
	MAX(IIF(t.timeframe = 'Day', t."commentCountRank", NULL)) AS "commentCountDayRank",
	MAX(IIF(t.timeframe = 'Week', t."commentCount", NULL)) AS "commentCountWeek",
	MAX(IIF(t.timeframe = 'Week', t."commentCountRank", NULL)) AS "commentCountWeekRank",
	MAX(IIF(t.timeframe = 'Month', t."commentCount", NULL)) AS "commentCountMonth",
	MAX(IIF(t.timeframe = 'Month', t."commentCountRank", NULL)) AS "commentCountMonthRank",
	MAX(IIF(t.timeframe = 'Year', t."commentCount", NULL)) AS "commentCountYear",
	MAX(IIF(t.timeframe = 'Year', t."commentCountRank", NULL)) AS "commentCountYearRank",
	MAX(IIF(t.timeframe = 'AllTime', t."commentCount", NULL)) AS "commentCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime', t."commentCountRank", NULL)) AS "commentCountAllTimeRank",
	MAX(IIF(t.timeframe = 'Day', t."checkCount", NULL)) AS "checkCountDay",
	MAX(IIF(t.timeframe = 'Day', t."checkCountRank", NULL)) AS "checkCountDayRank",
	MAX(IIF(t.timeframe = 'Week', t."checkCount", NULL)) AS "checkCountWeek",
	MAX(IIF(t.timeframe = 'Week', t."checkCountRank", NULL)) AS "checkCountWeekRank",
	MAX(IIF(t.timeframe = 'Month', t."checkCount", NULL)) AS "checkCountMonth",
	MAX(IIF(t.timeframe = 'Month', t."checkCountRank", NULL)) AS "checkCountMonthRank",
	MAX(IIF(t.timeframe = 'Year', t."checkCount", NULL)) AS "checkCountYear",
	MAX(IIF(t.timeframe = 'Year', t."checkCountRank", NULL)) AS "checkCountYearRank",
	MAX(IIF(t.timeframe = 'AllTime', t."checkCount", NULL)) AS "checkCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime', t."checkCountRank", NULL)) AS "checkCountAllTimeRank",
	MAX(IIF(t.timeframe = 'Day', t."crossCount", NULL)) AS "crossCountDay",
	MAX(IIF(t.timeframe = 'Day', t."crossCountRank", NULL)) AS "crossCountDayRank",
	MAX(IIF(t.timeframe = 'Week', t."crossCount", NULL)) AS "crossCountWeek",
	MAX(IIF(t.timeframe = 'Week', t."crossCountRank", NULL)) AS "crossCountWeekRank",
	MAX(IIF(t.timeframe = 'Month', t."crossCount", NULL)) AS "crossCountMonth",
	MAX(IIF(t.timeframe = 'Month', t."crossCountRank", NULL)) AS "crossCountMonthRank",
	MAX(IIF(t.timeframe = 'Year', t."crossCount", NULL)) AS "crossCountYear",
	MAX(IIF(t.timeframe = 'Year', t."crossCountRank", NULL)) AS "crossCountYearRank",
	MAX(IIF(t.timeframe = 'AllTime', t."crossCount", NULL)) AS "crossCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime', t."crossCountRank", NULL)) AS "crossCountAllTimeRank"
FROM (
	SELECT
		a.id AS "answerId",
		COALESCE(am."heartCount", 0) AS "heartCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(am."heartCount", 0) DESC, COALESCE(am."checkCount", 0) DESC, COALESCE(am."crossCount", 0), COALESCE(am."commentCount", 0) DESC, a.Id DESC) AS "heartCountRank",
		COALESCE(am."commentCount", 0) AS "commentCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(am."commentCount", 0) DESC, COALESCE(am."heartCount", 0) DESC, COALESCE(am."checkCount", 0) DESC, a.Id DESC) AS "commentCountRank",
    COALESCE(am."checkCount", 0) AS "checkCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(am."checkCount", 0) DESC, COALESCE(am."crossCount", 0), COALESCE(am."heartCount", 0) DESC, COALESCE(am."commentCount", 0) DESC, a.Id DESC) AS "checkCountRank",
		COALESCE(am."crossCount", 0) AS "crossCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(am."crossCount", 0) DESC, COALESCE(am."checkCount", 0), COALESCE(am."heartCount", 0) DESC, COALESCE(am."commentCount", 0) DESC, a.Id DESC) AS "crossCountRank",
		tf.timeframe
	FROM "Answer" a
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "AnswerMetric" am ON am."answerId" = a.id AND am.timeframe = tf.timeframe
) t
GROUP BY t."answerId";

CREATE VIEW "QuestionRank" AS
SELECT
	t."questionId",
	MAX(IIF(t.timeframe = 'Day', t."heartCount", NULL)) AS "heartCountDay",
	MAX(IIF(t.timeframe = 'Day', t."heartCountRank", NULL)) AS "heartCountDayRank",
	MAX(IIF(t.timeframe = 'Week', t."heartCount", NULL)) AS "heartCountWeek",
	MAX(IIF(t.timeframe = 'Week', t."heartCountRank", NULL)) AS "heartCountWeekRank",
	MAX(IIF(t.timeframe = 'Month', t."heartCount", NULL)) AS "heartCountMonth",
	MAX(IIF(t.timeframe = 'Month', t."heartCountRank", NULL)) AS "heartCountMonthRank",
	MAX(IIF(t.timeframe = 'Year', t."heartCount", NULL)) AS "heartCountYear",
	MAX(IIF(t.timeframe = 'Year', t."heartCountRank", NULL)) AS "heartCountYearRank",
	MAX(IIF(t.timeframe = 'AllTime', t."heartCount", NULL)) AS "heartCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime', t."heartCountRank", NULL)) AS "heartCountAllTimeRank",
	MAX(IIF(t.timeframe = 'Day', t."commentCount", NULL)) AS "commentCountDay",
	MAX(IIF(t.timeframe = 'Day', t."commentCountRank", NULL)) AS "commentCountDayRank",
	MAX(IIF(t.timeframe = 'Week', t."commentCount", NULL)) AS "commentCountWeek",
	MAX(IIF(t.timeframe = 'Week', t."commentCountRank", NULL)) AS "commentCountWeekRank",
	MAX(IIF(t.timeframe = 'Month', t."commentCount", NULL)) AS "commentCountMonth",
	MAX(IIF(t.timeframe = 'Month', t."commentCountRank", NULL)) AS "commentCountMonthRank",
	MAX(IIF(t.timeframe = 'Year', t."commentCount", NULL)) AS "commentCountYear",
	MAX(IIF(t.timeframe = 'Year', t."commentCountRank", NULL)) AS "commentCountYearRank",
	MAX(IIF(t.timeframe = 'AllTime', t."commentCount", NULL)) AS "commentCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime', t."commentCountRank", NULL)) AS "commentCountAllTimeRank",
	MAX(IIF(t.timeframe = 'Day', t."answerCount", NULL)) AS "answerCountDay",
	MAX(IIF(t.timeframe = 'Day', t."answerCountRank", NULL)) AS "answerCountDayRank",
	MAX(IIF(t.timeframe = 'Week', t."answerCount", NULL)) AS "answerCountWeek",
	MAX(IIF(t.timeframe = 'Week', t."answerCountRank", NULL)) AS "answerCountWeekRank",
	MAX(IIF(t.timeframe = 'Month', t."answerCount", NULL)) AS "answerCountMonth",
	MAX(IIF(t.timeframe = 'Month', t."answerCountRank", NULL)) AS "answerCountMonthRank",
	MAX(IIF(t.timeframe = 'Year', t."answerCount", NULL)) AS "answerCountYear",
	MAX(IIF(t.timeframe = 'Year', t."answerCountRank", NULL)) AS "answerCountYearRank",
	MAX(IIF(t.timeframe = 'AllTime', t."answerCount", NULL)) AS "answerCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime', t."answerCountRank", NULL)) AS "answerCountAllTimeRank"
FROM (
	SELECT
		q.id AS "questionId",
		COALESCE(qm."heartCount", 0) AS "heartCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(qm."heartCount", 0) DESC, COALESCE(qm."answerCount", 0) DESC, COALESCE(qm."commentCount", 0) DESC, q.Id DESC) AS "heartCountRank",
		COALESCE(qm."commentCount", 0) AS "commentCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(qm."commentCount", 0) DESC, COALESCE(qm."heartCount", 0) DESC, COALESCE(qm."answerCount", 0) DESC, q.Id DESC) AS "commentCountRank",
    COALESCE(qm."answerCount", 0) AS "answerCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(qm."answerCount", 0) DESC, COALESCE(qm."heartCount", 0) DESC, COALESCE(qm."commentCount", 0) DESC, q.Id DESC) AS "answerCountRank",
		tf.timeframe
	FROM "Question" q
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "QuestionMetric" qm ON qm."questionId" = q.id AND qm.timeframe = tf.timeframe
) t
GROUP BY t."questionId";
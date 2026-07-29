-- CreateTable
CREATE TABLE "ArticleRatingReview" (
    "id" SERIAL NOT NULL,
    "articleId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" INTEGER,
    "currentLevel" INTEGER NOT NULL,
    "suggestedLevel" INTEGER NOT NULL,
    "appliedLevel" INTEGER,
    "userComment" TEXT,
    "modComment" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'Pending',

    CONSTRAINT "ArticleRatingReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArticleRatingReview_status_createdAt_idx" ON "ArticleRatingReview"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ArticleRatingReview_userId_idx" ON "ArticleRatingReview"("userId");

-- CreateIndex
-- Composite index ordered DESC by createdAt so `findFirst({ where: { articleId }, orderBy: { createdAt: 'desc' } })`
-- (the owner re-edit gate + getArticleRatingReviewForOwner) is served directly from the index.
CREATE INDEX "ArticleRatingReview_articleId_createdAt_idx" ON "ArticleRatingReview"("articleId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ArticleRatingReview"
  ADD CONSTRAINT "ArticleRatingReview_articleId_fkey"
  FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleRatingReview"
  ADD CONSTRAINT "ArticleRatingReview_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleRatingReview"
  ADD CONSTRAINT "ArticleRatingReview_resolvedBy_fkey"
  FOREIGN KEY ("resolvedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial unique index: enforce at most one Pending review per article at the DB level.
-- Prisma does not natively support partial unique indexes, so this is appended manually.
-- `"status"` is double-quoted to match the rest of the file's identifier-quoting convention.
CREATE UNIQUE INDEX "ArticleRatingReview_pending_per_article"
  ON "ArticleRatingReview"("articleId")
  WHERE "status" = 'Pending';

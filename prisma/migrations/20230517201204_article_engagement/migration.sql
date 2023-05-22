-- CreateEnum
CREATE TYPE "ArticleEngagementType" AS ENUM ('Favorite', 'Hide');

-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "statusSetAt" TIMESTAMP(3);
UPDATE "Report" SET "statusSetAt" = now() WHERE "status" != 'Pending';
INSERT INTO "KeyValue"("key", "value") VALUES ('last-sent-notification-report-actioned', '1684354560266'::jsonb)
ON CONFLICT("key") DO NOTHING;

-- CreateTable
CREATE TABLE "ArticleEngagement" (
    "userId" INTEGER NOT NULL,
    "articleId" INTEGER NOT NULL,
    "type" "ArticleEngagementType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleEngagement_pkey" PRIMARY KEY ("userId","articleId")
);

-- CreateIndex
CREATE INDEX "ArticleEngagement_articleId_idx" ON "ArticleEngagement" USING HASH ("articleId");

-- AddForeignKey
ALTER TABLE "ArticleEngagement" ADD CONSTRAINT "ArticleEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleEngagement" ADD CONSTRAINT "ArticleEngagement_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

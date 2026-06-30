BEGIN;
-- CreateEnum
CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published', 'Unpublished');

-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "status" "ArticleStatus" NOT NULL DEFAULT 'Draft';

UPDATE "Article"
SET "status" = CASE
  WHEN "publishedAt" IS NOT NULL
    THEN 'Published'::"ArticleStatus"
  ELSE 'Draft'::"ArticleStatus" END;
END;

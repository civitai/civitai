

-- AlterTable
ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS     "coverId" INTEGER;

delete from "Article" where cover like 'blob%'

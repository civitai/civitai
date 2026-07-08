

-- AlterTable
ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS     "coverId" INTEGER;
ALTER TABLE "Article" ALTER COLUMN cover DROP NOT NULL;

delete from "Article" where cover like 'blob%'

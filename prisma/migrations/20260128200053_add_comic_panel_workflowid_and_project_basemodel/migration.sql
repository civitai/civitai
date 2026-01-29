-- AlterTable
ALTER TABLE "comic_panels" ADD COLUMN "workflowId" TEXT;

-- AlterTable
ALTER TABLE "comic_projects" ADD COLUMN "baseModel" VARCHAR(50);

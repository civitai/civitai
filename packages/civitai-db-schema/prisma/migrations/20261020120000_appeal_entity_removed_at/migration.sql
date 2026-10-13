-- Apply BEFORE the build that reads it is deployed: Prisma selects every column of "Appeal", so
-- that build fails on any appeal read until the column exists. Old builds ignore it.
ALTER TABLE "Appeal" ADD COLUMN IF NOT EXISTS "entityRemovedAt" TIMESTAMP(3);

-- Apply only AFTER the build carrying this enum value is deployed to every pod: a row with a label
-- the running Prisma client does not know throws on read for every reader of "JobQueue".
ALTER TYPE "JobQueueType" ADD VALUE IF NOT EXISTS 'ImageStorageDelete';

ALTER TABLE "JobQueue" ADD COLUMN IF NOT EXISTS "url" TEXT;

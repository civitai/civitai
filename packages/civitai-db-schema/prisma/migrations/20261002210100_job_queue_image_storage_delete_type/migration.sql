-- Apply AFTER the deploy has reached every pod. A row carrying a label the running Prisma client does
-- not know throws on read for every Prisma reader of JobQueue.
ALTER TYPE "JobQueueType" ADD VALUE IF NOT EXISTS 'ImageStorageDelete';

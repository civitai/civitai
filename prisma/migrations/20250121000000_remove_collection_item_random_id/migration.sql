-- AlterTable: Remove randomId column from CollectionItem
-- This column is no longer needed as random ordering is now computed using hash-based ordering with a seed stored in Redis

ALTER TABLE "CollectionItem" DROP COLUMN IF EXISTS "randomId";

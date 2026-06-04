-- CreateEnum

CREATE TYPE "CheckpointType" AS ENUM ('Trained', 'Merge');

-- AlterTable

ALTER TABLE "Model" ADD COLUMN "checkpointType" "CheckpointType";


UPDATE "Model"
SET "checkpointType" = 'Trained'
WHERE type = 'Checkpoint';


UPDATE "Model"
SET "checkpointType" = 'Merge'
WHERE (lower(description) LIKE '%mix%'
       OR lower(description) LIKE '%merge%')
  AND lower(description) NOT LIKE '%train%'
  AND type = 'Checkpoint'
  AND name NOT LIKE 'djz%';


-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights app: it reads and writes all three tables.
CREATE TABLE IF NOT EXISTS "KnightsQuestion" (
  "key" TEXT PRIMARY KEY,
  "version" INTEGER NOT NULL DEFAULT 1,
  "kind" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "options" JSONB NOT NULL,
  "minRank" TEXT NOT NULL DEFAULT 'Knight',
  "votesToResolve" INTEGER NOT NULL DEFAULT 5,
  "maxVotes" INTEGER NOT NULL DEFAULT 10,
  "threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "KnightsQueueItem" (
  "id" SERIAL PRIMARY KEY,
  "questionKey" TEXT NOT NULL REFERENCES "KnightsQuestion"("key") ON DELETE CASCADE ON UPDATE CASCADE,
  "imageId" INTEGER NOT NULL,
  "source" TEXT NOT NULL,
  "minRank" TEXT NOT NULL,
  "votesNeeded" INTEGER NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 2,
  "status" TEXT NOT NULL DEFAULT 'Open',
  "expiresAt" TIMESTAMP(3),
  "isHiddenCheck" BOOLEAN NOT NULL DEFAULT false,
  "resolvedValue" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" INTEGER,
  "appliedAt" TIMESTAMP(3),
  "resolvedFromLevel" INTEGER,
  "applyAttempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "KnightsQueueItem_status_minRank_priority_createdAt_idx"
  ON "KnightsQueueItem" ("status", "minRank", "priority", "createdAt");
CREATE INDEX IF NOT EXISTS "KnightsQueueItem_status_expiresAt_idx" ON "KnightsQueueItem" ("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "KnightsQueueItem_status_appliedAt_idx" ON "KnightsQueueItem" ("status", "appliedAt");
CREATE INDEX IF NOT EXISTS "KnightsQueueItem_imageId_idx" ON "KnightsQueueItem" ("imageId");

-- Partitioned by month. A unique key on a partitioned table must include the partition key, so
-- one vote per (item, player) is enforced by the vote path under the item row lock.
CREATE TABLE IF NOT EXISTS "KnightsVote" (
  "itemId" INTEGER NOT NULL,
  "playerId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "questionKey" TEXT NOT NULL,
  "imageId" INTEGER NOT NULL,
  "stage" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "weight" DOUBLE PRECISION NOT NULL,
  "verdict" TEXT NOT NULL DEFAULT 'pending',
  "gold" INTEGER,
  "labelled" BOOLEAN NOT NULL DEFAULT false,
  "converted" BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY ("itemId", "playerId", "createdAt")
) PARTITION BY RANGE ("createdAt");

CREATE INDEX IF NOT EXISTS "KnightsVote_playerId_createdAt_idx" ON "KnightsVote" ("playerId", "createdAt");
CREATE INDEX IF NOT EXISTS "KnightsVote_itemId_stage_idx" ON "KnightsVote" ("itemId", "stage");

-- Current month and the next two. The Knights app's partition job keeps creating them ahead of time,
-- and a vote creates its own month's partition if the job has not.
DO $$
DECLARE
  month_start DATE;
BEGIN
  FOR month_start IN
    SELECT generate_series(date_trunc('month', now())::date, (date_trunc('month', now()) + interval '2 months')::date, interval '1 month')::date
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "KnightsVote" FOR VALUES FROM (%L) TO (%L)',
      'KnightsVote_' || to_char(month_start, 'YYYY_MM'),
      month_start,
      (month_start + interval '1 month')::date
    );
  END LOOP;
END $$;

INSERT INTO "KnightsQuestion" ("key", "kind", "prompt", "options")
VALUES (
  'knights.image.nsfwLevel',
  'choice',
  'How should this image be rated?',
  '[{"value":"1","label":"PG"},{"value":"2","label":"PG-13"},{"value":"4","label":"R"},{"value":"8","label":"X"},{"value":"16","label":"XXX"},{"value":"32","label":"Blocked"}]'::jsonb
)
ON CONFLICT ("key") DO NOTHING;

-- Idempotent: applied by hand, possibly more than once.
--
-- Creator Journey milestones: definitions, plus one row per user per milestone achieved.
-- Seeds the nine Creator Score tiers. Badge cosmetics are attached later (cosmeticId stays NULL here).
--
-- 🔴 APPLY BEFORE ANY CODE THAT WRITES THESE TABLES DEPLOYS.

SET lock_timeout = '3s';

BEGIN;

-- Repeated inside the transaction: a session-level SET does not survive a transaction-mode pooler.
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "CreatorMilestone" (
  "key" TEXT NOT NULL,
  "track" TEXT NOT NULL,
  "threshold" INTEGER,
  "hidden" BOOLEAN NOT NULL DEFAULT false,
  "hint" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "cosmeticId" INTEGER,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "CreatorMilestone_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "CreatorMilestone_track_check" CHECK (
    "track" IN ('score', 'create', 'reach', 'compete', 'earn', 'community', 'hidden')
  ),
  CONSTRAINT "CreatorMilestone_threshold_check" CHECK ("threshold" IS NULL OR "threshold" > 0),
  CONSTRAINT "CreatorMilestone_cosmeticId_fkey" FOREIGN KEY ("cosmeticId")
    REFERENCES "Cosmetic"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "UserCreatorMilestone" (
  "userId" INTEGER NOT NULL,
  "milestoneKey" TEXT NOT NULL,
  "achievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "seenAt" TIMESTAMP(3),
  CONSTRAINT "UserCreatorMilestone_pkey" PRIMARY KEY ("userId", "milestoneKey"),
  CONSTRAINT "UserCreatorMilestone_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UserCreatorMilestone_milestoneKey_fkey" FOREIGN KEY ("milestoneKey")
    REFERENCES "CreatorMilestone"("key") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- The PK serves per-user reads. This serves per-milestone holder counts (rarity) and the FK check
-- on a definition's key.
CREATE INDEX IF NOT EXISTS "UserCreatorMilestone_milestoneKey_idx"
  ON "UserCreatorMilestone"("milestoneKey");

INSERT INTO "CreatorMilestone" ("key", "track", "threshold", "name", "description", "sortOrder")
VALUES
  ('score:spark',     'score',      500, 'Spark',     'Reached a Creator Score of 500.',        1),
  ('score:kindle',    'score',     1000, 'Kindle',    'Reached a Creator Score of 1,000.',      2),
  ('score:flame',     'score',     5000, 'Flame',     'Reached a Creator Score of 5,000.',      3),
  ('score:blaze',     'score',    10000, 'Blaze',     'Reached a Creator Score of 10,000.',     4),
  ('score:beacon',    'score',    40000, 'Beacon',    'Reached a Creator Score of 40,000.',     5),
  ('score:nova',      'score',   100000, 'Nova',      'Reached a Creator Score of 100,000.',    6),
  ('score:star',      'score',   250000, 'Star',      'Reached a Creator Score of 250,000.',    7),
  ('score:supernova', 'score',  1000000, 'Supernova', 'Reached a Creator Score of 1,000,000.',  8),
  ('score:legend',    'score', 10000000, 'Legend',    'Reached a Creator Score of 10,000,000.', 9)
ON CONFLICT ("key") DO NOTHING;

COMMIT;

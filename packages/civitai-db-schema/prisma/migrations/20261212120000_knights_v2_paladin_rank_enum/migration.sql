-- Idempotent: applied by hand, possibly more than once. Its own file: a new enum label must ship after the client
-- that knows it, so it cannot ride with the tables or columns.
-- Apply after the main app (regenerated Prisma client: Prisma throws on a label it does not know) and BEFORE the
-- Knights deploy: Knights compares "rankType" with 'Paladin' (leaderboard, notify), which fails while the label is missing.
-- Run the two statements as separate autocommit statements: a new enum label cannot be used in the transaction that adds it.
ALTER TYPE "NewOrderRankType" ADD VALUE IF NOT EXISTS 'Paladin';

-- "NewOrderPlayer"."rankType" references this table, so Paladin needs a row (copied from Templar).
INSERT INTO "NewOrderRank" ("type", "name", "minExp", "iconUrl", "updatedAt")
SELECT 'Paladin', 'Paladin', "minExp", "iconUrl", CURRENT_TIMESTAMP
FROM "NewOrderRank"
WHERE "type" = 'Templar'
ON CONFLICT ("type") DO NOTHING;

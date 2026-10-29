-- Idempotent: applied by hand, possibly more than once.
-- Deploy the regenerated Prisma client BEFORE applying this (.claude/rules/database.md, "Adding an enum value"):
-- Prisma throws on a label it does not know, and the Knights app writes 'Paladin' once a player earns it.
-- Run the two statements as separate autocommit statements: a new enum label cannot be used in the transaction that adds it.
ALTER TYPE "NewOrderRankType" ADD VALUE IF NOT EXISTS 'Paladin';

-- "NewOrderPlayer"."rankType" references this table, so a Paladin needs its row. Modelled on the Templar row.
INSERT INTO "NewOrderRank" ("type", "name", "minExp", "iconUrl", "updatedAt")
SELECT 'Paladin', 'Paladin', "minExp", "iconUrl", CURRENT_TIMESTAMP
FROM "NewOrderRank"
WHERE "type" = 'Templar'
ON CONFLICT ("type") DO NOTHING;

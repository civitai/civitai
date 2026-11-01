-- Awards a moderator release left neither paid nor refunded, kept for a manual ruling. No foreign
-- key to "Bounty": the record outlives the bounty. Open while "resolvedAt" is null.
CREATE TABLE IF NOT EXISTS "BountyUnpaidAward" (
  "bountyId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "unitAmount" INTEGER NOT NULL,
  "buzzTransactionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "winnerUserId" INTEGER,
  "ownerId" INTEGER,
  "recordedById" INTEGER,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ruling" TEXT,
  "ledgerReference" TEXT,
  "resolvedById" INTEGER,
  "resolvedAt" TIMESTAMP(3),
  PRIMARY KEY ("bountyId", "userId")
);

-- Awards recorded before this table existed, from their ModActivity record. Safe to re-run.
INSERT INTO "BountyUnpaidAward" (
  "bountyId", "userId", "unitAmount", "buzzTransactionIds", "winnerUserId", "ownerId",
  "recordedById", "recordedAt"
)
SELECT DISTINCT ON (m."entityId", m."userId")
  m."entityId", m."userId", bb."unitAmount", COALESCE(bb."buzzTransactionId", ARRAY[]::TEXT[]),
  b."payoutWinnerUserId",
  COALESCE(b."userId", (b.meta ->> 'userIdBeforeRemoval')::int), NULL, m."createdAt"
FROM "ModActivity" m
JOIN "BountyBenefactor" bb ON bb."bountyId" = m."entityId" AND bb."userId" = m."userId"
JOIN "Bounty" b ON b.id = m."entityId"
WHERE m."entityType" = 'bounty' AND m.activity = 'bountyAwardUnpaid'
ORDER BY m."entityId", m."userId", m."createdAt"
ON CONFLICT DO NOTHING;

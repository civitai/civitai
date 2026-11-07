-- Idempotent: applied by hand, possibly more than once.
-- Knights-owned tables only (none exists on main; "Image" must). Apply BEFORE deploying the Knights app, the moderator app
-- build that manages yes/no reference pairs, the main app build that enqueues rating items and the one with the shop endpoints;
-- the yes/no import runs after.
-- Apply after 20261209120000_knights_new_order_player_and_link_review.

-- Refuses a database that holds only part of the pre-consolidation chain: every table below is created with IF NOT
-- EXISTS, so a half-migrated table would be skipped and the indexes on its later columns would fail midway.
DO $$
DECLARE
  final_columns TEXT[][] := ARRAY[
    ['KnightsQueueItem', 'escalatedAt'], ['KnightsQueueItem', 'audience'], ['KnightsQueueItem', 'voteCount'],
    ['KnightsVote', 'consequence'], ['KnightsVote', 'noticedAt'], ['KnightsVote', 'blockReason'],
    ['KnightsPlayer', 'startAtSeen'], ['KnightsPlayer', 'recapPopupOptOut'], ['KnightsNotificationSend', 'kind']
  ];
  i INT;
BEGIN
  FOR i IN 1 .. array_length(final_columns, 1) LOOP
    IF to_regclass(format('%I', final_columns[i][1])) IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = final_columns[i][1] AND column_name = final_columns[i][2]
    ) THEN
      RAISE EXCEPTION 'Knights: "%" exists without "%"; this database holds part of the old migration chain. Finish that chain or drop the Knights tables first.',
        final_columns[i][1], final_columns[i][2];
    END IF;
  END LOOP;
  IF to_regclass('"KnightsGoldClearing"') IS NOT NULL OR to_regclass('"KnightsDetectionRun"') IS NOT NULL
    OR to_regclass('"KnightsTrialAnswer"') IS NOT NULL OR to_regclass('"KnightsTrialRun"') IS NOT NULL THEN
    RAISE EXCEPTION 'Knights: tables dropped by the old chain still exist; this database holds part of it. Finish that chain or drop the Knights tables first.';
  END IF;
END $$;

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

-- "minRank" is the stage the item waits at (Knight, Templar, Paladin, then the Inquisitors); "escalatedAt" is when it last
-- moved up. "externalId" is the producer's id for a yes/no question, null for rating items.
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
  "escalationReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "prediction" JSONB,
  "externalId" TEXT,
  "prompt" TEXT,
  "audience" TEXT,
  "yesEffect" TEXT,
  "noEffect" TEXT,
  "meta" JSONB,
  "voteCount" INTEGER NOT NULL DEFAULT 0,
  "escalatedAt" TIMESTAMP(3)
);

-- Databases that applied an earlier copy of this file have the table without "escalationReason"; CREATE TABLE IF NOT EXISTS skips it.
ALTER TABLE "KnightsQueueItem" ADD COLUMN IF NOT EXISTS "escalationReason" TEXT;

CREATE INDEX IF NOT EXISTS "KnightsQueueItem_status_minRank_priority_createdAt_idx"
  ON "KnightsQueueItem" ("status", "minRank", "priority", "createdAt");
CREATE INDEX IF NOT EXISTS "KnightsQueueItem_status_expiresAt_idx" ON "KnightsQueueItem" ("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "KnightsQueueItem_status_appliedAt_idx" ON "KnightsQueueItem" ("status", "appliedAt");
CREATE INDEX IF NOT EXISTS "KnightsQueueItem_imageId_idx" ON "KnightsQueueItem" ("imageId");

-- One open rating item per question and image. Hidden checks are exempt (served apart from the feed), and so is a yes/no
-- question (one of several that share an axis and an image; unique by externalId instead).
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsQueueItem_open_question_image_key"
  ON "KnightsQueueItem" ("questionKey", "imageId")
  WHERE "status" = 'Open' AND NOT "isHiddenCheck" AND "audience" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsQueueItem_externalId_key" ON "KnightsQueueItem" ("externalId");

CREATE INDEX IF NOT EXISTS "KnightsQueueItem_yesno_serve_idx"
  ON "KnightsQueueItem" ("questionKey", "voteCount" DESC, "priority", "id")
  WHERE "status" = 'Open' AND "audience" = 'players';

CREATE INDEX IF NOT EXISTS "KnightsQueueItem_yesno_answered_idx"
  ON "KnightsQueueItem" ("id")
  WHERE "status" = 'Open' AND "audience" IS NOT NULL AND "voteCount" > 0;

CREATE INDEX IF NOT EXISTS "KnightsQueueItem_open_escalated_idx"
  ON "KnightsQueueItem" ("minRank", "escalatedAt")
  WHERE "status" = 'Open' AND "escalatedAt" IS NOT NULL;

-- Partitioned by month. A unique key on a partitioned table must include the partition key, so
-- one vote per (item, player) is enforced by the vote path under the item row lock.
-- A hidden check is an ordinary KnightsVote with a negative itemId (minus its reference image id); "consequence" and
-- "noticedAt" record what grading it cost the player and whether the player dismissed the notice. "blockReason" is NULL
-- unless the vote is a Blocked rating.
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
  "xp" INTEGER NOT NULL DEFAULT 0,
  "settledAt" TIMESTAMP(3),
  "consequence" TEXT,
  "noticedAt" TIMESTAMP(3),
  "blockReason" TEXT
    CHECK ("blockReason" IN ('InappropriateMinors', 'RealisticMinors', 'DepictsRealPerson', 'Bestiality', 'Other')),
  PRIMARY KEY ("itemId", "playerId", "createdAt")
) PARTITION BY RANGE ("createdAt");

CREATE INDEX IF NOT EXISTS "KnightsVote_playerId_createdAt_idx" ON "KnightsVote" ("playerId", "createdAt");
CREATE INDEX IF NOT EXISTS "KnightsVote_itemId_stage_idx" ON "KnightsVote" ("itemId", "stage");

CREATE INDEX IF NOT EXISTS "KnightsVote_playerId_imageId_idx" ON "KnightsVote" ("playerId", "imageId");

CREATE INDEX IF NOT EXISTS "KnightsVote_unsettled_idx" ON "KnightsVote" ("itemId")
  WHERE "settledAt" IS NULL AND "verdict" <> 'pending';

CREATE INDEX IF NOT EXISTS "KnightsVote_unlabelled_keyset_idx" ON "KnightsVote" ("settledAt", "itemId", "playerId")
  WHERE "settledAt" IS NOT NULL AND NOT "labelled";

CREATE INDEX IF NOT EXISTS "KnightsVote_player_settled_gold_idx" ON "KnightsVote" ("playerId", "settledAt")
  WHERE "gold" > 0;

CREATE INDEX IF NOT EXISTS "KnightsVote_unnoticed_consequence_idx" ON "KnightsVote" ("playerId")
  WHERE "consequence" IS NOT NULL AND "noticedAt" IS NULL;

-- The weekly board groups votes cast in the window by player; `verdict` is carried so the scan skips the table.
CREATE INDEX IF NOT EXISTS "KnightsVote_createdAt_playerId_idx" ON "KnightsVote" ("createdAt", "playerId")
  INCLUDE ("verdict") WHERE "settledAt" IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS "KnightsPlayer" (
  "playerId" INTEGER NOT NULL,
  "streak" INTEGER NOT NULL DEFAULT 0,
  "lastWatchDay" DATE,
  "shields" INTEGER NOT NULL DEFAULT 0,
  "shieldWeek" DATE NOT NULL,
  "recapDismissedFor" DATE,
  -- The NewOrderPlayer.startAt the player has been told about; a later one is a career reset they have not seen yet.
  "startAtSeen" TIMESTAMP(3),
  "recapPopupOptOut" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "KnightsPlayer_pkey" PRIMARY KEY ("playerId")
);

CREATE TABLE IF NOT EXISTS "KnightsPlayerDay" (
  "playerId" INTEGER NOT NULL,
  "day" DATE NOT NULL,
  "votes" INTEGER NOT NULL DEFAULT 0,
  "goldRecorded" INTEGER NOT NULL DEFAULT 0,
  "watchCompletedAt" TIMESTAMP(3),
  "bonusGold" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "KnightsPlayerDay_pkey" PRIMARY KEY ("playerId", "day")
);

-- The play rail sums today's votes across players; (day, votes) lets that read be an index-only scan.
CREATE INDEX IF NOT EXISTS "KnightsPlayerDay_day_votes_idx" ON "KnightsPlayerDay" ("day", "votes");

CREATE TABLE IF NOT EXISTS "KnightsNotificationSend" (
  "playerId" INTEGER NOT NULL,
  "day" DATE NOT NULL,
  "kind" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMP(3),
  CONSTRAINT "KnightsNotificationSend_pkey" PRIMARY KEY ("playerId", "day")
);

CREATE INDEX IF NOT EXISTS "KnightsNotificationSend_playerId_kind_sentAt_idx"
  ON "KnightsNotificationSend" ("playerId", "kind", "sentAt");

CREATE TABLE IF NOT EXISTS "KnightsGoldConversion" (
  "id" SERIAL PRIMARY KEY,
  "playerId" INTEGER NOT NULL,
  "gold" INTEGER NOT NULL,
  "buzz" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "externalTransactionId" TEXT NOT NULL,
  "buzzTransactionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsGoldConversion_externalTransactionId_key" ON "KnightsGoldConversion" ("externalTransactionId");
CREATE INDEX IF NOT EXISTS "KnightsGoldConversion_playerId_createdAt_idx" ON "KnightsGoldConversion" ("playerId", "createdAt");
CREATE INDEX IF NOT EXISTS "KnightsGoldConversion_status_createdAt_idx" ON "KnightsGoldConversion" ("status", "createdAt");

-- Reference images feed the Acolyte apprenticeship. Unique across modules on purpose: one known answer per image, in one
-- pool, never both.
CREATE TABLE IF NOT EXISTS "KnightsReferenceImage" (
  "id" SERIAL PRIMARY KEY,
  "imageId" INTEGER NOT NULL,
  "questionKey" TEXT NOT NULL DEFAULT 'knights.image.nsfwLevel',
  "pool" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "explanation" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "modActivityId" INTEGER,
  "harvestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answers" INTEGER NOT NULL DEFAULT 0,
  "failures" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "KnightsReferenceImage_imageId_key" ON "KnightsReferenceImage" ("imageId");
CREATE INDEX IF NOT EXISTS "KnightsReferenceImage_pool_status_source_idx" ON "KnightsReferenceImage" ("pool", "status", "source");
CREATE INDEX IF NOT EXISTS "KnightsReferenceImage_modActivityId_idx" ON "KnightsReferenceImage" ("modActivityId");

CREATE TABLE IF NOT EXISTS "KnightsHarvestCursor" (
  "name" TEXT PRIMARY KEY,
  "lastActivityId" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "KnightsYesNoReference" (
  "id" SERIAL PRIMARY KEY,
  "imageId" INTEGER NOT NULL REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "questionKey" TEXT NOT NULL REFERENCES "KnightsQuestion"("key") ON DELETE CASCADE ON UPDATE CASCADE,
  "answer" BOOLEAN NOT NULL,
  "explanation" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "prompt" TEXT
);

-- Databases that applied an earlier copy of this file have the table without "prompt"; CREATE TABLE IF NOT EXISTS skips it.
ALTER TABLE "KnightsYesNoReference" ADD COLUMN IF NOT EXISTS "prompt" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "KnightsYesNoReference_imageId_questionKey_key"
  ON "KnightsYesNoReference" ("imageId", "questionKey");
CREATE INDEX IF NOT EXISTS "KnightsYesNoReference_active_questionKey_idx"
  ON "KnightsYesNoReference" ("active", "questionKey");

-- Answers outlive their reference: the "imageId"/"questionKey" snapshot identifies the answer once both reference FKs go
-- NULL (ON DELETE SET NULL).
CREATE TABLE IF NOT EXISTS "KnightsApprenticeAnswer" (
  "id" SERIAL PRIMARY KEY,
  "playerId" INTEGER NOT NULL,
  "referenceId" INTEGER REFERENCES "KnightsReferenceImage"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "yesNoReferenceId" INTEGER REFERENCES "KnightsYesNoReference"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "answer" TEXT NOT NULL,
  "correctAnswer" TEXT NOT NULL,
  "correct" BOOLEAN NOT NULL,
  "xp" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "checkpointSeenAt" TIMESTAMP(3),
  "imageId" INTEGER,
  "questionKey" TEXT,
  CONSTRAINT "KnightsApprenticeAnswer_one_reference"
    CHECK (
      ("referenceId" IS NULL) <> ("yesNoReferenceId" IS NULL)
      OR ("imageId" IS NOT NULL AND "questionKey" IS NOT NULL AND "referenceId" IS NULL AND "yesNoReferenceId" IS NULL)
    )
);

-- Partial, so not expressible in Prisma. The (player, image, question) key keeps the no-repeat rule across a deleted and
-- re-added reference.
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsApprenticeAnswer_player_reference_key"
  ON "KnightsApprenticeAnswer" ("playerId", "referenceId") WHERE "referenceId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsApprenticeAnswer_player_yesno_key"
  ON "KnightsApprenticeAnswer" ("playerId", "yesNoReferenceId") WHERE "yesNoReferenceId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsApprenticeAnswer_player_image_question_key"
  ON "KnightsApprenticeAnswer" ("playerId", "imageId", "questionKey") WHERE "imageId" IS NOT NULL;
-- A player's latest answers, newest first.
CREATE INDEX IF NOT EXISTS "KnightsApprenticeAnswer_playerId_id_idx"
  ON "KnightsApprenticeAnswer" ("playerId", "id");
CREATE INDEX IF NOT EXISTS "KnightsApprenticeAnswer_referenceId_idx"
  ON "KnightsApprenticeAnswer" ("referenceId") WHERE "referenceId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "KnightsApprenticeAnswer_yesNoReferenceId_idx"
  ON "KnightsApprenticeAnswer" ("yesNoReferenceId") WHERE "yesNoReferenceId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "KnightsAcolyteLevelGold" (
  "playerId" INTEGER NOT NULL,
  "level" INTEGER NOT NULL,
  "gold" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnightsAcolyteLevelGold_pkey" PRIMARY KEY ("playerId", "level")
);

-- The gold shop: a catalog, and the gold ledger of what was bought. The catalog is managed from the moderator app
-- (/knights-of-new-order/shop) in every environment, dev included.
CREATE TABLE IF NOT EXISTS "KnightsShopItem" (
  "id" SERIAL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "price" INTEGER NOT NULL,
  "buzz" INTEGER,
  "cosmeticId" INTEGER,
  "tier" TEXT,
  "days" INTEGER,
  "minRank" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "rotating" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnightsShopItem_kind_check" CHECK (
    ("kind" = 'buzz_pack' AND "buzz" > 0 AND "cosmeticId" IS NULL AND "tier" IS NULL)
    OR ("kind" = 'cosmetic' AND "cosmeticId" IS NOT NULL AND "buzz" IS NULL AND "tier" IS NULL)
    OR ("kind" = 'membership' AND "tier" IN ('bronze', 'silver', 'gold') AND "days" > 0 AND "buzz" IS NULL AND "cosmeticId" IS NULL)
  ),
  CONSTRAINT "KnightsShopItem_price_check" CHECK ("price" > 0)
);

CREATE TABLE IF NOT EXISTS "KnightsShopPurchase" (
  "id" SERIAL PRIMARY KEY,
  "playerId" INTEGER NOT NULL,
  "requestKey" TEXT NOT NULL,
  "externalKey" TEXT NOT NULL,
  "itemId" INTEGER NOT NULL REFERENCES "KnightsShopItem"("id"),
  "kind" TEXT NOT NULL,
  "gold" INTEGER NOT NULL,
  "grant" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "conversionId" INTEGER,
  "dealDay" DATE,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "grantedAt" TIMESTAMP(3),
  CONSTRAINT "KnightsShopPurchase_status_check" CHECK ("status" IN ('pending', 'granted', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "KnightsShopPurchase_playerId_requestKey_key" ON "KnightsShopPurchase" ("playerId", "requestKey");
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsShopPurchase_externalKey_key" ON "KnightsShopPurchase" ("externalKey");
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsShopPurchase_conversionId_key" ON "KnightsShopPurchase" ("conversionId") WHERE "conversionId" IS NOT NULL;
-- One deal-priced purchase of an item per player per UTC day.
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsShopPurchase_deal_once_key" ON "KnightsShopPurchase" ("playerId", "itemId", "dealDay")
  WHERE "dealDay" IS NOT NULL AND "status" <> 'failed';
CREATE INDEX IF NOT EXISTS "KnightsShopPurchase_playerId_createdAt_idx" ON "KnightsShopPurchase" ("playerId", "createdAt");
CREATE INDEX IF NOT EXISTS "KnightsShopPurchase_pending_idx" ON "KnightsShopPurchase" ("createdAt") WHERE "status" = 'pending';

-- userId is the moderator and has no foreign key, so deleting a user never rewrites the trail.
CREATE TABLE IF NOT EXISTS "KnightsShopItemChange" (
  "id" SERIAL PRIMARY KEY,
  "itemId" INTEGER NOT NULL REFERENCES "KnightsShopItem"("id"),
  "userId" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "changes" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnightsShopItemChange_action_check" CHECK ("action" IN ('create', 'update', 'retire', 'restore'))
);

CREATE INDEX IF NOT EXISTS "KnightsShopItemChange_itemId_createdAt_idx"
  ON "KnightsShopItemChange" ("itemId", "createdAt" DESC);

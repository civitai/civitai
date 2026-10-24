-- Mystery boxes on a general item model: a catalog of things that can be held or rewarded
-- ("ItemDefinition"), what users hold ("Item"), a box's tiers and full contents, and the record of each
-- opened box. Buying a box grants one held "Item"; opening it draws a reward and deletes the box.
--
-- New tables plus one nullable column on "CosmeticShopItem", so nothing reads or writes them until the
-- code that uses them ships. Apply any time before that deploy. Runs in one transaction.

BEGIN;

CREATE TABLE IF NOT EXISTS "ItemDefinition" (
  "id"                SERIAL PRIMARY KEY,
  -- Text + CHECK, not an enum: a new type is a CHECK change, with no deploy-first enum step.
  "type"              TEXT NOT NULL CONSTRAINT "ItemDefinition_type_check" CHECK ("type" IN ('cosmetic', 'box')),
  "name"              TEXT NOT NULL,
  "description"       TEXT,
  "imageUrl"          TEXT,
  "params"            JSONB NOT NULL DEFAULT '{}',
  "cosmeticId"        INTEGER UNIQUE REFERENCES "Cosmetic"("id") ON DELETE RESTRICT,
  "rarity"            TEXT,
  "value"             INTEGER,
  "flags"             INTEGER NOT NULL DEFAULT 0,
  "quantityAvailable" INTEGER,
  "version"           INTEGER NOT NULL DEFAULT 1,
  "status"            TEXT NOT NULL DEFAULT 'draft' CONSTRAINT "ItemDefinition_status_check" CHECK ("status" IN ('draft', 'published', 'archived')),
  "createdById"       INTEGER,
  "updatedById"       INTEGER,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "ItemDefinition_cosmetic_has_cosmeticId_check" CHECK ("type" <> 'cosmetic' OR "cosmeticId" IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS "ItemDefinition_type_status_idx" ON "ItemDefinition" ("type", "status");

CREATE TABLE IF NOT EXISTS "Item" (
  "id"               BIGSERIAL PRIMARY KEY,
  "itemDefinitionId" INTEGER NOT NULL REFERENCES "ItemDefinition"("id") ON DELETE RESTRICT,
  "holderType"       TEXT NOT NULL CONSTRAINT "Item_holderType_check" CHECK ("holderType" IN ('user')),
  "holderId"         INTEGER NOT NULL,
  "quantity"         INTEGER NOT NULL DEFAULT 1 CONSTRAINT "Item_quantity_check" CHECK ("quantity" > 0),
  "expiresAt"        TIMESTAMP(3),
  "data"             JSONB NOT NULL DEFAULT '{}',
  "sourceKey"        TEXT NOT NULL UNIQUE,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Item_holderType_holderId_itemDefinitionId_idx"
  ON "Item" ("holderType", "holderId", "itemDefinitionId");
CREATE INDEX IF NOT EXISTS "Item_itemDefinitionId_idx" ON "Item" ("itemDefinitionId");

CREATE TABLE IF NOT EXISTS "BoxTier" (
  "id"              SERIAL PRIMARY KEY,
  "boxDefinitionId" INTEGER NOT NULL REFERENCES "ItemDefinition"("id") ON DELETE CASCADE,
  "key"             TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "weight"          INTEGER NOT NULL CONSTRAINT "BoxTier_weight_check" CHECK ("weight" > 0),
  "color"           TEXT,
  "sortOrder"       INTEGER NOT NULL DEFAULT 0,
  UNIQUE ("boxDefinitionId", "key")
);

CREATE TABLE IF NOT EXISTS "BoxContent" (
  "id"                 SERIAL PRIMARY KEY,
  "boxDefinitionId"    INTEGER NOT NULL REFERENCES "ItemDefinition"("id") ON DELETE CASCADE,
  "tierId"             INTEGER NOT NULL REFERENCES "BoxTier"("id") ON DELETE RESTRICT,
  "rewardDefinitionId" INTEGER NOT NULL REFERENCES "ItemDefinition"("id") ON DELETE RESTRICT,
  "enabled"            BOOLEAN NOT NULL DEFAULT true,
  -- One tier per reward: listed twice, a reward's odds would double.
  UNIQUE ("boxDefinitionId", "rewardDefinitionId")
);
CREATE INDEX IF NOT EXISTS "BoxContent_tierId_idx" ON "BoxContent" ("tierId");
CREATE INDEX IF NOT EXISTS "BoxContent_rewardDefinitionId_idx" ON "BoxContent" ("rewardDefinitionId");

-- No foreign keys: the opened "Item" is deleted, and this row is the record of the open.
CREATE TABLE IF NOT EXISTS "BoxOpening" (
  "boxItemId"          BIGINT PRIMARY KEY,
  "boxDefinitionId"    INTEGER NOT NULL,
  "boxVersion"         INTEGER NOT NULL,
  "userId"             INTEGER NOT NULL,
  "boxSourceKey"       TEXT NOT NULL,
  "tierId"             INTEGER NOT NULL,
  "contentId"          INTEGER NOT NULL,
  "rewardDefinitionId" INTEGER NOT NULL,
  "rewardType"         TEXT NOT NULL,
  "tierWeight"         INTEGER NOT NULL,
  "eligibleWeight"     INTEGER NOT NULL,
  "tierRoll"           INTEGER NOT NULL,
  "tierPoolSize"       INTEGER NOT NULL,
  "itemRoll"           INTEGER NOT NULL,
  "rewardStatus"       TEXT NOT NULL CONSTRAINT "BoxOpening_rewardStatus_check" CHECK ("rewardStatus" IN ('granted')),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT now()
);
-- A user can draw a given cosmetic from a box once. The service's per-user lock is the primary guard;
-- this turns a bug in it into a failed open instead of a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS "BoxOpening_cosmetic_reward_once_key"
  ON "BoxOpening" ("userId", "boxDefinitionId", "rewardDefinitionId")
  WHERE "rewardType" = 'cosmetic';
CREATE INDEX IF NOT EXISTS "BoxOpening_userId_createdAt_idx" ON "BoxOpening" ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "BoxOpening_boxDefinitionId_createdAt_idx"
  ON "BoxOpening" ("boxDefinitionId", "createdAt");

CREATE TABLE IF NOT EXISTS "BoxOddsSnapshot" (
  "boxDefinitionId" INTEGER NOT NULL REFERENCES "ItemDefinition"("id") ON DELETE CASCADE,
  "version"         INTEGER NOT NULL,
  "snapshot"        JSONB NOT NULL,
  "createdById"     INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("boxDefinitionId", "version")
);

ALTER TABLE "CosmeticShopItem"
  ADD COLUMN IF NOT EXISTS "itemDefinitionId" INTEGER
  REFERENCES "ItemDefinition"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "CosmeticShopItem_itemDefinitionId_idx"
  ON "CosmeticShopItem" ("itemDefinitionId");

COMMIT;

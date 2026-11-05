-- Idempotent: applied by hand, possibly more than once. Additive only: two new tables, nothing existing is altered.
-- Deploy order: apply this migration, then deploy the main app (the membership and cosmetic endpoints under
-- /api/mod/knights/shop), then deploy Knights. Run `pnpm run seed:shop` in apps/knights to load the placeholder catalog.

CREATE TABLE IF NOT EXISTS "KnightsShopItem" (
  "id" TEXT PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "price" INTEGER NOT NULL,
  "buzz" INTEGER,
  "cosmeticId" INTEGER,
  "tier" TEXT,
  "months" INTEGER,
  "minRank" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "rotating" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnightsShopItem_kind_check" CHECK (
    ("kind" = 'buzz_pack' AND "buzz" > 0 AND "cosmeticId" IS NULL AND "tier" IS NULL)
    OR ("kind" = 'cosmetic' AND "cosmeticId" IS NOT NULL AND "buzz" IS NULL AND "tier" IS NULL)
    OR ("kind" = 'membership' AND "tier" IN ('bronze', 'silver', 'gold') AND "months" > 0 AND "buzz" IS NULL AND "cosmeticId" IS NULL)
  ),
  CONSTRAINT "KnightsShopItem_price_check" CHECK ("price" > 0)
);

CREATE TABLE IF NOT EXISTS "KnightsShopPurchase" (
  "id" SERIAL PRIMARY KEY,
  "playerId" INTEGER NOT NULL,
  "requestKey" TEXT NOT NULL,
  "externalKey" TEXT NOT NULL,
  "itemId" TEXT NOT NULL REFERENCES "KnightsShopItem"("id"),
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

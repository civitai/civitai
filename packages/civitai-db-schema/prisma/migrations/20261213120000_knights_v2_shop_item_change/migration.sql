-- The audit trail of Knights shop catalog edits made from the moderator app (/knights-of-new-order/shop).
-- `changes` maps each changed field to {from, to}. `userId` is the moderator and has no foreign key on purpose.
CREATE TABLE IF NOT EXISTS "KnightsShopItemChange" (
  "id" SERIAL PRIMARY KEY,
  "itemId" TEXT NOT NULL REFERENCES "KnightsShopItem"("id"),
  "userId" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "changes" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnightsShopItemChange_action_check" CHECK ("action" IN ('create', 'update', 'retire', 'restore'))
);

CREATE INDEX IF NOT EXISTS "KnightsShopItemChange_itemId_createdAt_idx"
  ON "KnightsShopItemChange" ("itemId", "createdAt" DESC);

-- Add tokenScope bitmask column to ApiKey (default = Full = 33554431)
ALTER TABLE "ApiKey" ADD COLUMN "tokenScope" INTEGER NOT NULL DEFAULT 33554431;

-- Add lastUsedAt tracking
ALTER TABLE "ApiKey" ADD COLUMN "lastUsedAt" TIMESTAMP(3);

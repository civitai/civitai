-- Add buzzTransactionId column to CrucibleEntry for tracking entry fee transactions
-- This allows refunds when a crucible is cancelled
ALTER TABLE "CrucibleEntry" ADD COLUMN IF NOT EXISTS "buzzTransactionId" TEXT;

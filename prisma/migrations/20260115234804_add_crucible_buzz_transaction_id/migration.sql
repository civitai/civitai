-- Add buzzTransactionId to Crucible for tracking creator setup fee transactions
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "buzzTransactionId" TEXT;

-- Buyer attachments on Creator Services deals. Applied by hand.
-- Both statements are additive: no existing row changes, and nothing writes the new value until the
-- `creator-services-attachments` flag is turned on after the deploy.
ALTER TYPE "ServiceDealFileKind" ADD VALUE IF NOT EXISTS 'Attachment';

ALTER TABLE "ServiceDealFile" ADD COLUMN IF NOT EXISTS "attestedAt" TIMESTAMP(3);

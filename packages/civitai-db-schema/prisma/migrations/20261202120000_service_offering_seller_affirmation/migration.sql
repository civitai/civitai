-- Idempotent: applied by hand, possibly more than once.
--
-- The seller's agreement to the Creator Services terms when they publish an offering: userId,
-- offeringId, affirmedAt, version and the statement verbatim, like the Creator Shop's
-- meta.rightsAffirmation. Null until first published. Apply BEFORE deploying the code that reads it.

ALTER TABLE "ServiceOffering" ADD COLUMN IF NOT EXISTS "sellerAffirmation" JSONB;

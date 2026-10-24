-- Idempotent: applied by hand, possibly more than once.
--
-- A structured reason on a Creator Services deal event (decline, cancellation request, dispute), so a
-- muted user can still give one without free text. Nullable with no CHECK: the allowed codes live in
-- shared constants and are validated in the API. Apply BEFORE deploying the code that writes it.

ALTER TABLE "ServiceDealEvent" ADD COLUMN IF NOT EXISTS "reasonCode" TEXT;

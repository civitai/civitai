-- The send job claims an unsent CSAM report before it opens a CyberTip for it, and releases the
-- claim in the same write that marks the report sent. A filing never folds into a claimed report
-- unless the claim has expired, and every write the send job makes is conditional on its claim.
--
-- Apply BEFORE deploying the code that reads these columns. Unsent rows only ever carry a claim, so
-- the append-only trigger on sent rows is unaffected.

ALTER TABLE "CsamReport"
  ADD COLUMN "sendClaimId" UUID,
  ADD COLUMN "sendClaimedAt" TIMESTAMP(3),
  -- A claim with no time would never expire.
  ADD CONSTRAINT "CsamReport_sendClaim_check"
    CHECK (("sendClaimId" IS NULL) = ("sendClaimedAt" IS NULL));

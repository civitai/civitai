-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying: the dispute queue reads each deal's latest review from this table.
CREATE TABLE IF NOT EXISTS "ServiceDisputeReview" (
  "id" SERIAL PRIMARY KEY,
  "dealId" INTEGER NOT NULL REFERENCES "ServiceDeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "class" TEXT NOT NULL,
  "proposal" "ServiceDisputeResolution",
  "confidence" DOUBLE PRECISION,
  "rationale" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "agentVersion" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "humanRuling" "ServiceDisputeResolution",
  "humanId" INTEGER,
  "agreed" BOOLEAN,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ServiceDisputeReview_dealId_idx" ON "ServiceDisputeReview" ("dealId");

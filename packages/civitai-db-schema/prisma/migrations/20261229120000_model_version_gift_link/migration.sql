-- Gift links for gated model versions (docs/features/model-gift-links.md).
--
-- Apply BEFORE deploying the code that reads these tables. Hand-applied. Two new, empty tables:
-- no backfill, no rewrite of an existing table.
-- Dry run: the whole file inside BEGIN; ... ROLLBACK;.
-- The drift check covers neither the CHECKs nor the indexes: confirm them with \d after applying.

CREATE TABLE "ModelVersionGiftLink" (
  "id" SERIAL NOT NULL,
  "modelVersionId" INTEGER NOT NULL,
  "createdById" INTEGER NOT NULL,
  "codeHash" TEXT NOT NULL,
  "codeHint" TEXT NOT NULL,
  "label" TEXT,
  "batchId" TEXT,
  "maxRedemptions" INTEGER,
  "redemptionCount" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "revokedById" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ModelVersionGiftLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ModelVersionGiftLink_maxRedemptions_check"
    CHECK ("maxRedemptions" IS NULL OR "maxRedemptions" > 0),
  -- Backstop only: the claim's conditional UPDATE enforces the cap.
  CONSTRAINT "ModelVersionGiftLink_redemptionCount_check"
    CHECK ("maxRedemptions" IS NULL OR "redemptionCount" <= "maxRedemptions")
);

CREATE UNIQUE INDEX "ModelVersionGiftLink_codeHash_key" ON "ModelVersionGiftLink"("codeHash");
CREATE INDEX "ModelVersionGiftLink_modelVersionId_createdAt_idx"
  ON "ModelVersionGiftLink"("modelVersionId", "createdAt" DESC);
CREATE INDEX "ModelVersionGiftLink_batchId_idx" ON "ModelVersionGiftLink"("batchId");

ALTER TABLE "ModelVersionGiftLink"
  ADD CONSTRAINT "ModelVersionGiftLink_modelVersionId_fkey" FOREIGN KEY ("modelVersionId")
    REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ModelVersionGiftLink_createdById_fkey" FOREIGN KEY ("createdById")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ModelVersionGiftRedemption" (
  "giftLinkId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ModelVersionGiftRedemption_pkey" PRIMARY KEY ("giftLinkId", "userId")
);

CREATE INDEX "ModelVersionGiftRedemption_userId_idx" ON "ModelVersionGiftRedemption"("userId");

ALTER TABLE "ModelVersionGiftRedemption"
  ADD CONSTRAINT "ModelVersionGiftRedemption_giftLinkId_fkey" FOREIGN KEY ("giftLinkId")
    REFERENCES "ModelVersionGiftLink"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ModelVersionGiftRedemption_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

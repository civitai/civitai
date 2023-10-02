BEGIN;

-- CreateIndex
CREATE INDEX "ModelVersionPurchase_userId_idx" ON "ModelVersionPurchase" USING HASH ("userId");

-- CreateIndex
CREATE INDEX "ModelVersionPurchase_modelVersionId_idx" ON "ModelVersionPurchase" USING HASH ("modelVersionId");

COMMIT;

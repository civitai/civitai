-- CreateIndex
CREATE INDEX "VaultItem_vaultId_idx" ON "VaultItem" USING HASH ("vaultId");

-- CreateIndex
CREATE INDEX "VaultItem_modelVersionId_idx" ON "VaultItem" USING HASH ("modelVersionId");

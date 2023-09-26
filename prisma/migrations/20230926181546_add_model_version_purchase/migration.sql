BEGIN
-- CreateTable
CREATE TABLE "ModelVersionPurchase" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "transactionDetails" JSONB,

    CONSTRAINT "ModelVersionPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ModelFileToModelVersionPurchase" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "_ModelFileToModelVersionPurchase_AB_unique" ON "_ModelFileToModelVersionPurchase"("A", "B");

-- CreateIndex
CREATE INDEX "_ModelFileToModelVersionPurchase_B_index" ON "_ModelFileToModelVersionPurchase"("B");

-- AddForeignKey
ALTER TABLE "ModelVersionPurchase" ADD CONSTRAINT "ModelVersionPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelVersionPurchase" ADD CONSTRAINT "ModelVersionPurchase_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ModelFileToModelVersionPurchase" ADD CONSTRAINT "_ModelFileToModelVersionPurchase_A_fkey" FOREIGN KEY ("A") REFERENCES "ModelFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ModelFileToModelVersionPurchase" ADD CONSTRAINT "_ModelFileToModelVersionPurchase_B_fkey" FOREIGN KEY ("B") REFERENCES "ModelVersionPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;

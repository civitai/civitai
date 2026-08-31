-- Scheduled model sales (CU 868ktk1ku). A sale is an OVERLAY: PaidAccess.terms is never rewritten,
-- so a creator editing their base price mid-sale cannot lose it.

CREATE TYPE "SaleDiscountType" AS ENUM ('Fixed', 'Percent');

CREATE TABLE "ModelVersionSale" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER NOT NULL,
  "name" TEXT,
  "discountType" "SaleDiscountType" NOT NULL,
  "discountAmount" INTEGER NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "canceledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ModelVersionSale_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModelVersionSaleItem" (
  "saleId" INTEGER NOT NULL,
  "modelVersionId" INTEGER NOT NULL,

  CONSTRAINT "ModelVersionSaleItem_pkey" PRIMARY KEY ("saleId", "modelVersionId")
);

-- The creator's month-to-date sale-day budget is read by (userId, startsAt); the resolver reads by version.
CREATE INDEX "ModelVersionSale_userId_startsAt_idx" ON "ModelVersionSale"("userId", "startsAt");
CREATE INDEX "ModelVersionSaleItem_modelVersionId_idx" ON "ModelVersionSaleItem"("modelVersionId");
-- The resolver filters the sale side on endsAt > now. Rows are never deleted, so without this the scan
-- grows monotonically while the live set stays small.
CREATE INDEX "ModelVersionSale_endsAt_idx" ON "ModelVersionSale"("endsAt");

ALTER TABLE "ModelVersionSaleItem"
  ADD CONSTRAINT "ModelVersionSaleItem_saleId_fkey"
  FOREIGN KEY ("saleId") REFERENCES "ModelVersionSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

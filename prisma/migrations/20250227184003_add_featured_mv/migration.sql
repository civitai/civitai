ALTER TABLE "Auction" ADD COLUMN     "finalized" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "FeaturedModelVersion" (
    "id" SERIAL NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "FeaturedModelVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeaturedModelVersion_modelVersionId_key" ON "FeaturedModelVersion"("modelVersionId");
ALTER TABLE "FeaturedModelVersion" ADD CONSTRAINT "FeaturedModelVersion_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "FeaturedModelVersion_validFrom_validTo_idx" ON "FeaturedModelVersion"("validFrom", "validTo")

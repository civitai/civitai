-- CreateEnum
CREATE TYPE "AssociationType" AS ENUM ('Suggested');

-- CreateTable
CREATE TABLE "ModelAssociations" (
    "fromModelId" INTEGER NOT NULL,
    "toModelId" INTEGER NOT NULL,
    "associatedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "AssociationType" NOT NULL,
    "index" INTEGER,

    CONSTRAINT "ModelAssociations_pkey" PRIMARY KEY ("fromModelId","toModelId","type")
);

-- CreateIndex
CREATE INDEX "ModelAssociations_toModelId_idx" ON "ModelAssociations" USING HASH ("toModelId");

-- AddForeignKey
ALTER TABLE "ModelAssociations" ADD CONSTRAINT "ModelAssociations_fromModelId_fkey" FOREIGN KEY ("fromModelId") REFERENCES "Model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelAssociations" ADD CONSTRAINT "ModelAssociations_toModelId_fkey" FOREIGN KEY ("toModelId") REFERENCES "Model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Required for case-insensitive WildcardSet.name and WildcardSetCategory.name columns.
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateEnum
CREATE TYPE "WildcardSetKind" AS ENUM ('System', 'User');

-- CreateEnum
CREATE TYPE "WildcardSetAuditStatus" AS ENUM ('Pending', 'Clean', 'Mixed', 'Dirty');

-- CreateEnum
CREATE TYPE "WildcardSetCategoryAuditStatus" AS ENUM ('Pending', 'Clean', 'Dirty');

-- CreateTable
CREATE TABLE "WildcardSet" (
    "id" SERIAL NOT NULL,
    "kind" "WildcardSetKind" NOT NULL,
    "modelVersionId" INTEGER,
    "ownerUserId" INTEGER,
    "name" CITEXT NOT NULL,
    "auditStatus" "WildcardSetAuditStatus" NOT NULL DEFAULT 'Pending',
    "auditRuleVersion" TEXT,
    "auditedAt" TIMESTAMP(3),
    "nsfw" BOOLEAN NOT NULL DEFAULT false,
    "isInvalidated" BOOLEAN NOT NULL DEFAULT false,
    "invalidationReason" TEXT,
    "invalidatedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WildcardSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WildcardSetCategory" (
    "id" SERIAL NOT NULL,
    "wildcardSetId" INTEGER NOT NULL,
    "name" CITEXT NOT NULL,
    "values" TEXT[],
    "valueCount" INTEGER NOT NULL DEFAULT 0,
    "auditStatus" "WildcardSetCategoryAuditStatus" NOT NULL DEFAULT 'Pending',
    "auditRuleVersion" TEXT,
    "auditedAt" TIMESTAMP(3),
    "auditNote" TEXT,
    "nsfw" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WildcardSetCategory_pkey" PRIMARY KEY ("id")
);

-- Enforce kind invariant: System-kind has modelVersionId and no ownerUserId; User-kind is the inverse.
ALTER TABLE "WildcardSet" ADD CONSTRAINT "WildcardSet_kind_owner_check" CHECK (
    (kind = 'System' AND "modelVersionId" IS NOT NULL AND "ownerUserId" IS NULL)
    OR
    (kind = 'User' AND "modelVersionId" IS NULL AND "ownerUserId" IS NOT NULL)
);

-- CreateIndex
CREATE UNIQUE INDEX "WildcardSet_modelVersionId_key" ON "WildcardSet"("modelVersionId");

-- CreateIndex
CREATE INDEX "WildcardSet_kind_idx" ON "WildcardSet"("kind");

-- CreateIndex
CREATE INDEX "WildcardSet_ownerUserId_idx" ON "WildcardSet"("ownerUserId");

-- CreateIndex
CREATE INDEX "WildcardSet_auditStatus_idx" ON "WildcardSet"("auditStatus");

-- CreateIndex
CREATE INDEX "WildcardSet_isInvalidated_idx" ON "WildcardSet"("isInvalidated");

-- CreateIndex
-- Set-level nsfw rollup (boolean OR of every non-Dirty category's `nsfw`,
-- maintained by recomputeWildcardSetAuditStatus). Indexed so visibility
-- checks like `nsfw = false` on the .com side gate can avoid a sub-query
-- into WildcardSetCategory. Boolean, not bitwise, because XGuard's text
-- classifiers can't reliably distinguish PG / R / X for arbitrary text.
CREATE INDEX "WildcardSet_nsfw_idx" ON "WildcardSet"("nsfw");

-- CreateIndex
CREATE UNIQUE INDEX "WildcardSetCategory_wildcardSetId_name_key" ON "WildcardSetCategory"("wildcardSetId", "name");

-- CreateIndex
CREATE INDEX "WildcardSetCategory_wildcardSetId_idx" ON "WildcardSetCategory"("wildcardSetId");

-- CreateIndex
CREATE INDEX "WildcardSetCategory_wildcardSetId_auditStatus_idx" ON "WildcardSetCategory"("wildcardSetId", "auditStatus");

-- CreateIndex
CREATE INDEX "WildcardSetCategory_auditStatus_idx" ON "WildcardSetCategory"("auditStatus");

-- AddForeignKey
ALTER TABLE "WildcardSet" ADD CONSTRAINT "WildcardSet_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WildcardSet" ADD CONSTRAINT "WildcardSet_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WildcardSetCategory" ADD CONSTRAINT "WildcardSetCategory_wildcardSetId_fkey" FOREIGN KEY ("wildcardSetId") REFERENCES "WildcardSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- LicensingRoot: registry of chargeable licensing-root versions per (baseModel,
-- modelType). Membership = a row exists; `isDefault` marks the single root a
-- derivative pre-selects in the version form. Replaces (over two releases) the
-- ModelVersion.LicensingRoot flag (bit 2) + the BaseModelLicensingFee pointer.
--
-- Phase 1 (this migration): create + backfill the table and switch the version
-- form to read from it. The generation charge path (mini endpoint) still reads
-- the flag + BaseModelLicensingFee, which this backfill keeps in sync.
--
-- NOTE: applied MANUALLY (this repo does NOT use `prisma migrate deploy`).

-- CreateTable
CREATE TABLE "LicensingRoot" (
    "id" SERIAL NOT NULL,
    "baseModel" TEXT NOT NULL,
    "modelType" "ModelType" NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LicensingRoot_pkey" PRIMARY KEY ("id")
);

-- A version is a root at most once.
CREATE UNIQUE INDEX "LicensingRoot_modelVersionId_key" ON "LicensingRoot"("modelVersionId");

-- Scope lookup (form list + charge-path default).
CREATE INDEX "LicensingRoot_baseModel_modelType_idx" ON "LicensingRoot"("baseModel", "modelType");

-- FK mirrors BaseModelLicensingFee: a root row is meaningless without its version.
ALTER TABLE "LicensingRoot" ADD CONSTRAINT "LicensingRoot_modelVersionId_fkey"
  FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill. Each INSERT is existence-guarded via the ModelVersion join, so it
-- no-ops on environments where these versions don't exist (staging/dev).
-- ---------------------------------------------------------------------------

-- 1) Every version currently carrying the LicensingRoot flag (bit 2). Default
--    flag is unknown here, so seed isDefault=false; step 2 promotes the default.
INSERT INTO "LicensingRoot" ("baseModel", "modelType", "modelVersionId", "isDefault", "updatedAt")
SELECT mv."baseModel", m."type", mv.id, false, CURRENT_TIMESTAMP
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE (mv.flags & 2) = 2
ON CONFLICT ("modelVersionId") DO NOTHING;

-- 2) The current BaseModelLicensingFee pointer per (baseModel, modelType) IS the
--    default root. Insert it if the flag didn't already (e.g. Anima base-v1.0,
--    which is the default but was never flagged) and mark it default.
INSERT INTO "LicensingRoot" ("baseModel", "modelType", "modelVersionId", "isDefault", "updatedAt")
SELECT bmlf."baseModel", bmlf."modelType", bmlf."modelVersionId", true, CURRENT_TIMESTAMP
FROM "BaseModelLicensingFee" bmlf
JOIN "ModelVersion" mv ON mv.id = bmlf."modelVersionId"
ON CONFLICT ("modelVersionId") DO UPDATE SET "isDefault" = true, "updatedAt" = CURRENT_TIMESTAMP;

-- 3) Krea 2 checkpoints (not yet flagged or in BaseModelLicensingFee): Raw is the
--    default, Turbo is a selectable non-default root. IDs confirmed with product.
INSERT INTO "LicensingRoot" ("baseModel", "modelType", "modelVersionId", "isDefault", "updatedAt")
SELECT mv."baseModel", m."type", mv.id, (mv.id = 3072329), CURRENT_TIMESTAMP
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE mv.id IN (3072329, 3072332)
ON CONFLICT ("modelVersionId") DO UPDATE SET "isDefault" = EXCLUDED."isDefault", "updatedAt" = CURRENT_TIMESTAMP;

-- Enforce exactly one default per scope. Created AFTER backfill so a bad seed
-- surfaces as a migration failure rather than silently allowing two defaults.
CREATE UNIQUE INDEX "LicensingRoot_default_per_scope_key"
  ON "LicensingRoot"("baseModel", "modelType") WHERE "isDefault";

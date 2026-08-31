-- PHASE 2 CLEANUP — run only AFTER the Phase 2 code is deployed.
--
-- By this point the charge path (src/pages/api/v1/model-versions/mini/[id].ts)
-- resolves fees as:
--   tier 1 (is this a root?) -> a LicensingRoot row for this version -> own fee
--   tier 2 (explicit parent) -> licensingSourceVersionId's fee
-- The old tier-3 "(baseModel, modelType) default" fallback is gone, and root
-- membership comes from the LicensingRoot table — nothing reads the
-- ModelVersion.LicensingRoot flag (bit 2) or the BaseModelLicensingFee table
-- anymore. Running this before that code ships would break fee resolution.
--
-- Applied MANUALLY (this repo does NOT use `prisma migrate deploy`).

-- 1) Clear the retired LicensingRoot flag bit (2). Root membership now lives
--    entirely in the LicensingRoot table. The NotDerivative bit (4) is untouched.
UPDATE "ModelVersion"
SET "flags" = "flags" & ~2
WHERE ("flags" & 2) = 2;

-- 2) Drop the superseded pointer table (its default-root role moved to
--    LicensingRoot.isDefault). Its FK + index drop with it.
DROP TABLE "BaseModelLicensingFee";

-- Backfill explicit licensing parents on existing derivatives.
--
-- Design decision: a null licensingSourceVersionId means NO fee — it must NOT
-- fall back to the (baseModel, modelType) default. So every derivative that
-- should inherit the ecosystem fee needs its parent set explicitly. Run this
-- while the tier-3 default fallback is still active (Phase 1 charge path), so it
-- is a no-op for fees until the Phase 2 code removes that fallback.
--
-- Sets each version in a licensing ecosystem+type to that scope's default root.
-- Omits:
--   * the roots themselves (they charge their own fee via LicensingRoot),
--   * API-only official versions that intentionally carry NO fee (2983022, 2983023),
--   * versions that already have an explicit parent.
-- Uses the scope default for everything; creators/moderators can re-point a
-- specific version at a non-default root (e.g. Turbo) afterward via the form.
--
-- Requires the LicensingRoot table (20260715130000). Applied MANUALLY.

UPDATE "ModelVersion" mv
SET "licensingSourceVersionId" = d."modelVersionId"
FROM "LicensingRoot" d, "Model" m
WHERE m.id = mv."modelId"
  AND d."isDefault"
  AND mv."baseModel" = d."baseModel"
  AND m."type" = d."modelType"
  AND mv."licensingSourceVersionId" IS NULL
  AND mv.id NOT IN (2983022, 2983023)
  AND NOT EXISTS (SELECT 1 FROM "LicensingRoot" lr WHERE lr."modelVersionId" = mv.id);

-- Mark the API-only official Krea 2 versions as NotDerivative
-- (ModelVersionFlag.NotDerivative = bit 4): they aren't fine-tunes, so the
-- version form won't require/auto-select a parent for them. The flag governs
-- parent attribution only — such a version can still set its own fee. These two
-- carry no parent and no own fee today, so they charge nothing.
UPDATE "ModelVersion"
SET "flags" = "flags" | 4
WHERE id IN (2983022, 2983023)
  AND ("flags" & 4) = 0;

-- Model3DFile.variant — allows multiple Model3DFile rows to share a format
-- under the same Model3D. The PolyGen workflow can emit several semantically
-- distinct GLB exports for a single generation (textured base mesh, rigged
-- variant, animated variant, walking/running templates with armature-only
-- siblings); without a `variant` discriminator the existing
-- @@unique([model3dId, format]) constraint forces us to drop all but one.
--
-- Values used by the polygen handler:
--   primary           — the textured + remeshed base mesh
--   rigged            — the rigged variant
--   animated          — the animated variant
--   walking           — basicAnimations.walkingModel / walkingFbxModel
--   walking-armature  — basicAnimations.walkingArmatureModel
--   running           — basicAnimations.runningModel / runningFbxModel
--   running-armature  — basicAnimations.runningArmatureModel
ALTER TABLE "Model3DFile"
  ADD COLUMN IF NOT EXISTS "variant" TEXT NOT NULL DEFAULT 'primary';

-- Move the uniqueness from (model3dId, format) to (model3dId, format, variant)
-- so each variant can carry its own glb + fbx pair.
DROP INDEX IF EXISTS "Model3DFile_model3dId_format_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Model3DFile_model3dId_format_variant_key"
  ON "Model3DFile" ("model3dId", "format", "variant");

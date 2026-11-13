-- Custom profile showcase sections (feature flag `profile-showcases`).
-- A constant default makes this a metadata-only change: no table rewrite.
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "showcaseSections" JSONB NOT NULL DEFAULT '[]';

-- Per-Model3D gallery moderation settings (creator/mod hide images, users,
-- tags). Mirrors `Model.gallerySettings` JSONB but without a version
-- dimension — a 3D model has no versions, so `images` is a flat array of
-- hidden imageIds rather than a per-version map.
--
-- Shape:
--   {
--     "users":  number[],   -- hidden user ids
--     "tags":   number[],   -- hidden tag ids
--     "images": number[]    -- hidden image ids
--   }
ALTER TABLE "Model3D"
  ADD COLUMN IF NOT EXISTS "gallerySettings" JSONB
    NOT NULL
    DEFAULT '{"users":[],"tags":[],"images":[]}'::jsonb;

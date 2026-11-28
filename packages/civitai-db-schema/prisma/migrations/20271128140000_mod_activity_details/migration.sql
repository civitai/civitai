-- What a moderator action decided (setNsfwLevel: {from, to}; Audio review Held decisions). Nullable;
-- rows written before it stay NULL.
ALTER TABLE "ModActivity" ADD COLUMN IF NOT EXISTS "details" JSONB;

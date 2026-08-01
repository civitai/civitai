-- CreateIndex
-- Sticker slugs are the send-time lookup key, so they have to be unique across creators.
-- Must run after 20260801120000_add_cosmetic_type_sticker has committed: the 'Sticker'
-- enum value is not visible to this statement until that transaction ends.
CREATE UNIQUE INDEX IF NOT EXISTS "Cosmetic_sticker_slug_key"
  ON "Cosmetic" ((data ->> 'slug'))
  WHERE "type" = 'Sticker';

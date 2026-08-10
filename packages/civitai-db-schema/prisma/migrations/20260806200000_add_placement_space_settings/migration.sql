-- Per-space settings that belong to one surface rather than to the mechanism.
--
-- A column per idea does not scale: a max sticker size is meaningless to a remix
-- gallery, and the foundation's rule is that nothing in it knows which surface it
-- serves. Each surface reads its own keys out of this and the layer stays generic.
--
-- Applied by hand, so this has to survive a re-run.
ALTER TABLE "PlacementSpace"
  ADD COLUMN IF NOT EXISTS "settings" JSONB NOT NULL DEFAULT '{}';

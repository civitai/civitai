-- Backfill `Tag.target` so every tag currently attached to a Model3D
-- carries the `Model3D` target value.
--
-- Why this is needed:
--   `upsertModel3D` originally reused existing tags by name (e.g. `pokemon`,
--   which was created with target `['Image']` for the image feed) and
--   inserted a `TagsOnModel3D` row, but it never updated the tag's own
--   `target` array. That left a population of tags that are attached to
--   Model3Ds but invisible to anything that filters tags by
--   `target && '{Model3D}'`:
--     - the Model3D tag picker autocomplete (`tag.getAll` with
--       `entityType: [TagTarget.Model3D]`)
--     - the search-index target filter
--     - category-tag discovery for the feed scroller
--
--   `upsertModel3D` has been patched to append `Model3D` to the target
--   array on every attach (see model3d.service.ts), so this is a one-shot
--   backfill for tags that pre-date that patch.
--
-- Idempotent: the `NOT ('Model3D' = ANY ...)` guard means rerunning this
-- on an already-clean dataset is a no-op.
UPDATE "Tag" t
SET "target" = t."target" || ARRAY['Model3D']::"TagTarget"[]
WHERE EXISTS (SELECT 1 FROM "TagsOnModel3D" tom WHERE tom."tagId" = t.id)
  AND NOT ('Model3D' = ANY (t."target"));

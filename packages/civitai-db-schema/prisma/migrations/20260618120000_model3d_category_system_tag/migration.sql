-- Seed the system tag that anchors Model3D category tags. Mirrors the
-- existing `image category`, `model category`, `post category`, and
-- `article category` system tags — `getCategoryTags('model3d')` looks
-- for this row by name and treats every tag linked from it via
-- `TagsOnTags{type:Parent}` as a Model3D category.
--
-- Idempotent: the unique partial index on `Tag.name` makes the
-- ON CONFLICT no-op safe to re-run.
INSERT INTO "Tag" ("name", "type", "target", "createdAt", "updatedAt")
VALUES ('model3d category', 'System', ARRAY[]::"TagTarget"[], NOW(), NOW())
ON CONFLICT ("name") DO NOTHING;

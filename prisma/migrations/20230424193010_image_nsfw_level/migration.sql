/*
  Warnings:

  - The `nsfw` column on the `Image` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
BEGIN;
-- CreateEnum
CREATE TYPE "NsfwLevel" AS ENUM ('None', 'Soft', 'Mature', 'X');

-- AlterTable
ALTER TABLE "Image" RENAME "nsfw" TO "nsfw_old",
ADD COLUMN     "nsfw" "NsfwLevel" NOT NULL DEFAULT 'None';

-- TODO.justin: adjust nsfwLevel accordingly
UPDATE "Image" SET "nsfw" = 'None' WHERE "nsfw_old" = false;
UPDATE "Image" SET "nsfw" = 'Mature' WHERE "nsfw_old" = true;

ALTER TABLE "Image" DROP COLUMN "nsfw_old";
COMMIT;

BEGIN;
--- Add Tag Rating
INSERT INTO "Tag" (name, target, "createdAt", "updatedAt", type) VALUES
('rated 13+', ARRAY['Tag'::"TagTarget"]::"TagTarget"[], now(), now(), 'System'),
('rated m', ARRAY['Tag'::"TagTarget"]::"TagTarget"[], now(), now(), 'System'),
('rated x', ARRAY['Tag'::"TagTarget"]::"TagTarget"[], now(), now(), 'System')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "TagsOnTags" ("fromTagId", "toTagId")
SELECT
  t2.id, t1.id
FROM "Tag" t1
JOIN "Tag" t2 ON t2.name = 'rated 13+'
WHERE t1.name IN ('corpses', 'emaciated bodies', 'explosions and blasts', 'female swimwear or underwear', 'male swimwear or underwear', 'middle finger', 'partial nudity', 'physical violence', 'revealing clothes', 'sexual situations', 'weapon violence', 'weapons')
ON CONFLICT ("fromTagId", "toTagId") DO NOTHING;

INSERT INTO "TagsOnTags" ("fromTagId", "toTagId")
SELECT
  t2.id, t1.id
FROM "Tag" t1
JOIN "Tag" t2 ON t2.name = 'rated m'
WHERE t1.name IN ('white supremacy', 'adult toys', 'extremist', 'graphic violence or gore', 'hanging', 'hate symbols', 'nazi party', 'nudity')
ON CONFLICT ("fromTagId", "toTagId") DO NOTHING;

INSERT INTO "TagsOnTags" ("fromTagId", "toTagId")
SELECT
  t2.id, t1.id
FROM "Tag" t1
JOIN "Tag" t2 ON t2.name = 'rated x'
WHERE t1.name IN ('illustrated explicit nudity', 'graphic female nudity', 'graphic male nudity', 'sexual activity')
ON CONFLICT ("fromTagId", "toTagId") DO NOTHING;
COMMIT;

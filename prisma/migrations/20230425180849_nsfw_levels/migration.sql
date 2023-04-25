BEGIN;
-- CreateEnum
CREATE TYPE "NsfwLevel" AS ENUM ('None', 'Soft', 'Mature', 'X');

-- AlterTable
ALTER TABLE "Image" RENAME "nsfw" TO "nsfw_old";
ALTER TABLE "Image" ADD COLUMN     "nsfw" "NsfwLevel" NOT NULL DEFAULT 'None';

ALTER TABLE "TagsOnImage" ADD COLUMN     "disabledAt" TIMESTAMP(3);
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
WHERE t1.name IN ('corpses', 'emaciated bodies', 'explosions and blasts', 'female swimwear or underwear', 'male swimwear or underwear', 'middle finger', 'physical violence', 'revealing clothes', 'weapon violence', 'weapons')
ON CONFLICT ("fromTagId", "toTagId") DO NOTHING;

INSERT INTO "TagsOnTags" ("fromTagId", "toTagId")
SELECT
  t2.id, t1.id
FROM "Tag" t1
JOIN "Tag" t2 ON t2.name = 'rated m'
WHERE t1.name IN ('white supremacy', 'adult toys', 'extremist', 'graphic violence or gore', 'hanging', 'hate symbols', 'nazi party', 'nudity', 'partial nudity', 'sexual situations')
ON CONFLICT ("fromTagId", "toTagId") DO NOTHING;

INSERT INTO "TagsOnTags" ("fromTagId", "toTagId")
SELECT
  t2.id, t1.id
FROM "Tag" t1
JOIN "Tag" t2 ON t2.name = 'rated x'
WHERE t1.name IN ('illustrated explicit nudity', 'graphic female nudity', 'graphic male nudity', 'sexual activity')
ON CONFLICT ("fromTagId", "toTagId") DO NOTHING;
COMMIT;

BEGIN;
-- Set NSFW level based on tags
WITH tag_level AS (
	SELECT
	  tot."toTagId" "tagId",
	  CASE
	    WHEN t.name = 'rated 13+' THEN 'Soft'::"NsfwLevel"
		WHEN t.name = 'rated m' THEN 'Mature'::"NsfwLevel"
		WHEN t.name = 'rated x' THEN 'X'::"NsfwLevel"
		ELSE 'None'::"NsfwLevel"
	  END "level"
	FROM "TagsOnTags" tot
	JOIN "Tag" t ON t.id = tot."fromTagId"
	WHERE t.type = 'System' AND t.name IN ('rated 13+', 'rated m', 'rated x')
), image_level AS (
	SELECT
	  toi."imageId",
	  CASE
	    WHEN bool_or(tl.level = 'X') THEN 'X'::"NsfwLevel"
	    WHEN bool_or(tl.level = 'Mature') THEN 'Mature'::"NsfwLevel"
	    WHEN bool_or(tl.level = 'Soft') THEN 'Soft'::"NsfwLevel"
	    ELSE 'None'::"NsfwLevel"
	  END "nsfw"
	FROM "TagsOnImage" toi
	JOIN tag_level tl ON tl."tagId" = toi."tagId"
	GROUP BY toi."imageId"
)
UPDATE "Image" i SET nsfw = il.nsfw
FROM image_level il
WHERE il."imageId" = i.id;

ALTER TABLE "Image" DROP COLUMN "nsfw_old";
COMMIT;
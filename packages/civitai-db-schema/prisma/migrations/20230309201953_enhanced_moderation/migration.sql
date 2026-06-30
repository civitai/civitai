-- AlterEnum
ALTER TYPE "TagEngagementType" ADD VALUE 'Allow';

-- Add moderation tags
INSERT INTO "Tag" (name, "createdAt", "updatedAt", target, type)
VALUES
  ('nudity', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('graphic male nudity', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('graphic female nudity', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('sexual activity', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('illustrated explicit nudity', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('adult toys', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('female swimwear or underwear', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('male swimwear or underwear', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('partial nudity', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('barechested male', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('revealing clothes', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('sexual situations', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('graphic violence or gore', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('physical violence', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('weapon violence', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('weapons', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('self injury', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('emaciated bodies', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('corpses', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('hanging', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('air crash', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('explosions and blasts', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('middle finger', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('drug products', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('drug use', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('pills', now(), now(), '{"Image","Model"}', 'Moderation'),
  ('drug paraphernalia', now(), now(), '{"Image","Model"}', 'Moderation'),
	('tobacco products', now(), now(), '{"Image","Model"}', 'Moderation'),
	('smoking', now(), now(), '{"Image","Model"}', 'Moderation'),
	('drinking', now(), now(), '{"Image","Model"}', 'Moderation'),
	('alcoholic beverages', now(), now(), '{"Image","Model"}', 'Moderation'),
	('gambling', now(), now(), '{"Image","Model"}', 'Moderation'),
	('nazi party', now(), now(), '{"Image","Model"}', 'Moderation'),
	('white supremacy', now(), now(), '{"Image","Model"}', 'Moderation'),
	('extremist', now(), now(), '{"Image","Model"}', 'Moderation')
ON CONFLICT ("name") DO UPDATE
	SET type = 'Moderation', target = ARRAY_CAT(EXCLUDED.target, '{"Image","Model"}')
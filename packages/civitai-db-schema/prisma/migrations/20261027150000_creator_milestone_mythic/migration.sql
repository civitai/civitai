-- Idempotent: applied by hand, possibly more than once.
--
-- 🔴 APPLY ONLY AFTER 20261027140000_cosmetic_type_card_decoration AND THE CODE THAT SHIPS WITH IT
-- ARE LIVE: the row is what grants, so applied early it grants crossings silently. Creators already
-- past the threshold get the tier, silently, at their next score run or from the backfill.

SET lock_timeout = '3s';

BEGIN;

SET LOCAL lock_timeout = '3s';

INSERT INTO "Cosmetic" ("name", "description", "type", "source", "permanentUnlock", "data")
SELECT 'Mythic Creator Badge', 'Reached a Creator Score of 100,000,000', 'Badge', 'Trophy', true,
  '{"url": "8c2f33f7-a636-45da-b3c7-ca60c3983e88", "animated": true}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM "Cosmetic" WHERE "name" = 'Mythic Creator Badge' AND "type" = 'Badge'
);

INSERT INTO "Cosmetic" ("name", "description", "type", "source", "permanentUnlock", "data")
SELECT 'Mythic Card Glow', 'Reached a Creator Score of 100,000,000', 'CardDecoration', 'Trophy', true,
  '{"glow": {"color": "#F76707", "intensity": 0.7, "animated": true}}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM "Cosmetic" WHERE "name" = 'Mythic Card Glow' AND "type" = 'CardDecoration'
);

-- sortOrder sets the ladder order, which must match SCORE_TIERS.
INSERT INTO "CreatorMilestone" ("key", "track", "threshold", "name", "description", "cosmeticId", "sortOrder")
SELECT 'score:mythic', 'score', 100000000, 'Mythic', 'Reached a Creator Score of 100,000,000.',
  (SELECT min(id) FROM "Cosmetic" WHERE "name" = 'Mythic Creator Badge' AND "type" = 'Badge'), 10
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "CreatorMilestoneCosmetic" ("milestoneKey", "cosmeticId")
SELECT 'score:mythic', min(id)
FROM "Cosmetic" WHERE "name" = 'Mythic Card Glow' AND "type" = 'CardDecoration'
HAVING min(id) IS NOT NULL
ON CONFLICT DO NOTHING;

COMMIT;

-- Idempotent: applied by hand, possibly more than once.
--
-- The Mythic Creator Score tier (100,000,000), above Legend: its milestone row, its badge, and the
-- creator card glow it grants. The row is what grants: the code that announces it must deploy first,
-- or crossings are granted silently.
--
-- 🔴 APPLY ONLY AFTER 20261027120000_cosmetic_type_card_decoration AND THE CODE THAT SHIPS WITH IT
-- ARE LIVE. Creators already past the threshold get the tier from the next nightly score run that
-- touches them, or at once from the score-tier backfill, silently either way.
--
-- The badge art is a placeholder (the hidden-achievement hexagon) until the Mythic art exists;
-- replace "data".url on the 'Mythic Creator Badge' row then.

SET lock_timeout = '3s';

BEGIN;

SET LOCAL lock_timeout = '3s';

INSERT INTO "Cosmetic" ("name", "description", "type", "source", "permanentUnlock", "data")
SELECT 'Mythic Creator Badge', 'Reached a Creator Score of 100,000,000', 'Badge', 'Trophy', true,
  '{"url": "697cac26-7f27-4205-8a3c-886d31e17153", "animated": false}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM "Cosmetic" WHERE "name" = 'Mythic Creator Badge' AND "type" = 'Badge'
);

INSERT INTO "Cosmetic" ("name", "description", "type", "source", "permanentUnlock", "data")
SELECT 'Mythic Card Glow', 'Reached a Creator Score of 100,000,000', 'CardDecoration', 'Trophy', true,
  '{"glow": {"color": "#22b8cf", "intensity": 0.7, "animated": true}}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM "Cosmetic" WHERE "name" = 'Mythic Card Glow' AND "type" = 'CardDecoration'
);

-- sortOrder 10 follows score:legend (9): the ladder is read in this order and must match SCORE_TIERS.
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

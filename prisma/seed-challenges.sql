-- TODO.challenge: Delete this file once seed data is no longer needed.
-- =============================================================================
-- Challenge Seed Data
-- =============================================================================
-- Creates 8 challenges covering all lifecycle states with linked collections,
-- collection items (entries), and winner records.
--
-- Idempotent: cleans up prior seed data using metadata->>'seed' = 'true'
-- marker on challenges and name LIKE '[SEED]%' on collections.
--
-- Run with: psql or the postgres-query skill with --writable
-- =============================================================================

DO $$
DECLARE
  -- Collection IDs
  col1 INT; col2 INT; col3 INT; col4 INT;
  col5 INT; col6 INT; col7 INT; col8 INT;
  -- Challenge IDs
  ch1 INT; ch2 INT; ch3 INT; ch4 INT;
  ch5 INT; ch6 INT; ch7 INT; ch8 INT;
  -- Constants
  civbot_id    CONSTANT INT := 6235605;
  civchan_id   CONSTANT INT := 7665867;
  judged_tag   CONSTANT INT := 299729;
  review_tag   CONSTANT INT := 301770;
  mv_ids       CONSTANT INT[] := ARRAY[2245488, 2245473, 2245464, 2245462, 2245458];
  prizes_json  CONSTANT JSONB := '[{"buzz":5000,"points":150},{"buzz":2500,"points":100},{"buzz":1500,"points":50}]';
  entry_prize  CONSTANT JSONB := '{"buzz":200,"points":10}';
BEGIN
  -- ===========================================================================
  -- Step 0: Cleanup prior seed data (dependency order)
  -- ===========================================================================
  DELETE FROM "ChallengeWinner"
    WHERE "challengeId" IN (
      SELECT id FROM "Challenge" WHERE metadata->>'seed' = 'true'
    );

  DELETE FROM "CollectionItem"
    WHERE "collectionId" IN (
      SELECT id FROM "Collection" WHERE name LIKE '[SEED]%'
    );

  DELETE FROM "Challenge"
    WHERE metadata->>'seed' = 'true';

  DELETE FROM "Collection"
    WHERE name LIKE '[SEED]%';

  -- ===========================================================================
  -- Step 1: Insert 8 Collections
  -- ===========================================================================

  -- 1. Neon Dreams (Scheduled — write=Private)
  INSERT INTO "Collection" (
    "name", "userId", "imageId", "type", "mode",
    "write", "read", "availability", "nsfwLevel",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    '[SEED] Neon Dreams', civbot_id, 96487754,
    'Image'::"CollectionType", 'Contest'::"CollectionMode",
    'Private'::"CollectionWriteConfiguration", 'Public'::"CollectionReadConfiguration",
    'Public'::"Availability", 0,
    '{}'::jsonb, NOW(), NOW()
  ) RETURNING id INTO col1;

  -- 2. Cosmic Gardens (Scheduled — write=Private)
  INSERT INTO "Collection" (
    "name", "userId", "imageId", "type", "mode",
    "write", "read", "availability", "nsfwLevel",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    '[SEED] Cosmic Gardens', civbot_id, 67828013,
    'Image'::"CollectionType", 'Contest'::"CollectionMode",
    'Private'::"CollectionWriteConfiguration", 'Public'::"CollectionReadConfiguration",
    'Public'::"Availability", 0,
    '{}'::jsonb, NOW(), NOW()
  ) RETURNING id INTO col2;

  -- 3. Urban Legends (Active — write=Review)
  INSERT INTO "Collection" (
    "name", "userId", "imageId", "type", "mode",
    "write", "read", "availability", "nsfwLevel",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    '[SEED] Urban Legends', civbot_id, 67824074,
    'Image'::"CollectionType", 'Contest'::"CollectionMode",
    'Review'::"CollectionWriteConfiguration", 'Public'::"CollectionReadConfiguration",
    'Public'::"Availability", 0,
    '{}'::jsonb, NOW(), NOW()
  ) RETURNING id INTO col3;

  -- 4. Crystal Caverns (Active — write=Review, CivChan)
  INSERT INTO "Collection" (
    "name", "userId", "imageId", "type", "mode",
    "write", "read", "availability", "nsfwLevel",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    '[SEED] Crystal Caverns', civchan_id, 67365098,
    'Image'::"CollectionType", 'Contest'::"CollectionMode",
    'Review'::"CollectionWriteConfiguration", 'Public'::"CollectionReadConfiguration",
    'Public'::"Availability", 0,
    '{}'::jsonb, NOW(), NOW()
  ) RETURNING id INTO col4;

  -- 5. Sunset Warriors (Active, just ended — write=Review)
  INSERT INTO "Collection" (
    "name", "userId", "imageId", "type", "mode",
    "write", "read", "availability", "nsfwLevel",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    '[SEED] Sunset Warriors', civbot_id, 67823010,
    'Image'::"CollectionType", 'Contest'::"CollectionMode",
    'Review'::"CollectionWriteConfiguration", 'Public'::"CollectionReadConfiguration",
    'Public'::"Availability", 0,
    '{}'::jsonb, NOW(), NOW()
  ) RETURNING id INTO col5;

  -- 6. Enchanted Forest (Completed — write=Private, CivChan)
  INSERT INTO "Collection" (
    "name", "userId", "imageId", "type", "mode",
    "write", "read", "availability", "nsfwLevel",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    '[SEED] Enchanted Forest', civchan_id, 67134122,
    'Image'::"CollectionType", 'Contest'::"CollectionMode",
    'Private'::"CollectionWriteConfiguration", 'Public'::"CollectionReadConfiguration",
    'Public'::"Availability", 0,
    '{}'::jsonb, NOW(), NOW()
  ) RETURNING id INTO col6;

  -- 7. Frozen Realms (Cancelled — write=Private)
  INSERT INTO "Collection" (
    "name", "userId", "imageId", "type", "mode",
    "write", "read", "availability", "nsfwLevel",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    '[SEED] Frozen Realms', civbot_id, 67821254,
    'Image'::"CollectionType", 'Contest'::"CollectionMode",
    'Private'::"CollectionWriteConfiguration", 'Public'::"CollectionReadConfiguration",
    'Public'::"Availability", 0,
    '{}'::jsonb, NOW(), NOW()
  ) RETURNING id INTO col7;

  -- 8. Pixel Pandemonium (Active, stress test — write=Review)
  INSERT INTO "Collection" (
    "name", "userId", "imageId", "type", "mode",
    "write", "read", "availability", "nsfwLevel",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    '[SEED] Pixel Pandemonium', civbot_id, 67824074,
    'Image'::"CollectionType", 'Contest'::"CollectionMode",
    'Review'::"CollectionWriteConfiguration", 'Public'::"CollectionReadConfiguration",
    'Public'::"Availability", 0,
    '{}'::jsonb, NOW(), NOW()
  ) RETURNING id INTO col8;

  -- ===========================================================================
  -- Step 2: Insert 8 Challenges
  -- ===========================================================================

  -- 1. Neon Dreams — Scheduled, starts tomorrow
  INSERT INTO "Challenge" (
    "title", "description", "theme", "invitation",
    "startsAt", "endsAt", "visibleAt",
    "coverImageId", "nsfwLevel", "allowedNsfwLevel",
    "modelVersionIds", "collectionId", "createdById",
    "status", "source",
    "prizes", "entryPrize", "entryPrizeRequirement",
    "prizePool", "operationBudget",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    'Neon Dreams',
    'Create stunning neon-lit artwork that captures the essence of cyberpunk dreams and electric nightscapes.',
    'Neon & Cyberpunk',
    'Light up the night with your neon creations!',
    NOW() + INTERVAL '1 day',
    NOW() + INTERVAL '4 days',
    NOW(),
    96487754, 1, 1,
    mv_ids, col1, civbot_id,
    'Scheduled'::"ChallengeStatus", 'System'::"ChallengeSource",
    prizes_json, entry_prize, 10,
    9000, 5000,
    '{"seed": true}'::jsonb, NOW(), NOW()
  ) RETURNING id INTO ch1;

  -- 2. Cosmic Gardens — Scheduled, starts in 3 days
  INSERT INTO "Challenge" (
    "title", "description", "theme", "invitation",
    "startsAt", "endsAt", "visibleAt",
    "coverImageId", "nsfwLevel", "allowedNsfwLevel",
    "modelVersionIds", "collectionId", "createdById",
    "status", "source",
    "prizes", "entryPrize", "entryPrizeRequirement",
    "prizePool", "operationBudget",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    'Cosmic Gardens',
    'Imagine gardens among the stars — alien flora, nebula blooms, and cosmic botanical wonders.',
    'Space & Nature',
    'Grow something out of this world!',
    NOW() + INTERVAL '3 days',
    NOW() + INTERVAL '6 days',
    NOW() + INTERVAL '2 days',
    67828013, 1, 1,
    mv_ids, col2, civbot_id,
    'Scheduled'::"ChallengeStatus", 'System'::"ChallengeSource",
    prizes_json, entry_prize, 10,
    9000, 5000,
    '{"seed": true}'::jsonb, NOW(), NOW()
  ) RETURNING id INTO ch2;

  -- 3. Urban Legends — Active, started yesterday, ends tomorrow
  INSERT INTO "Challenge" (
    "title", "description", "theme", "invitation",
    "startsAt", "endsAt", "visibleAt",
    "coverImageId", "nsfwLevel", "allowedNsfwLevel",
    "modelVersionIds", "collectionId", "createdById",
    "status", "source",
    "prizes", "entryPrize", "entryPrizeRequirement",
    "prizePool", "operationBudget",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    'Urban Legends',
    'Bring urban myths and city folklore to life through striking visual art.',
    'Urban & Mythology',
    'Every city has its legends — show us yours!',
    NOW() - INTERVAL '1 day',
    NOW() + INTERVAL '1 day',
    NOW() - INTERVAL '2 days',
    67824074, 1, 1,
    mv_ids, col3, civbot_id,
    'Active'::"ChallengeStatus", 'System'::"ChallengeSource",
    prizes_json, entry_prize, 10,
    9000, 5000,
    '{"seed": true}'::jsonb, NOW() - INTERVAL '1 day', NOW()
  ) RETURNING id INTO ch3;

  -- 4. Crystal Caverns — Active, started 2 days ago, ends in 2 days (CivChan)
  INSERT INTO "Challenge" (
    "title", "description", "theme", "invitation",
    "startsAt", "endsAt", "visibleAt",
    "coverImageId", "nsfwLevel", "allowedNsfwLevel",
    "modelVersionIds", "collectionId", "createdById",
    "status", "source",
    "prizes", "entryPrize", "entryPrizeRequirement",
    "prizePool", "operationBudget",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    'Crystal Caverns',
    'Explore the depths of crystal-filled underground worlds — gemstones, bioluminescence, and subterranean beauty.',
    'Underground & Crystals',
    'Dig deep and discover hidden wonders!',
    NOW() - INTERVAL '2 days',
    NOW() + INTERVAL '2 days',
    NOW() - INTERVAL '3 days',
    67365098, 1, 1,
    mv_ids, col4, civchan_id,
    'Active'::"ChallengeStatus", 'System'::"ChallengeSource",
    prizes_json, entry_prize, 10,
    9000, 5000,
    '{"seed": true}'::jsonb, NOW() - INTERVAL '2 days', NOW()
  ) RETURNING id INTO ch4;

  -- 5. Sunset Warriors — Active, started 2 days ago, ended 1 min ago
  INSERT INTO "Challenge" (
    "title", "description", "theme", "invitation",
    "startsAt", "endsAt", "visibleAt",
    "coverImageId", "nsfwLevel", "allowedNsfwLevel",
    "modelVersionIds", "collectionId", "createdById",
    "status", "source",
    "prizes", "entryPrize", "entryPrizeRequirement",
    "prizePool", "operationBudget",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    'Sunset Warriors',
    'Warriors silhouetted against blazing sunsets — epic battles at golden hour.',
    'Warriors & Sunsets',
    'Fight for glory in the dying light!',
    NOW() - INTERVAL '2 days',
    NOW() - INTERVAL '1 minute',
    NOW() - INTERVAL '3 days',
    67823010, 1, 1,
    mv_ids, col5, civbot_id,
    'Active'::"ChallengeStatus", 'System'::"ChallengeSource",
    prizes_json, entry_prize, 10,
    9000, 5000,
    '{"seed": true}'::jsonb, NOW() - INTERVAL '2 days', NOW()
  ) RETURNING id INTO ch5;

  -- 6. Enchanted Forest — Completed, ended 3 days ago (CivChan)
  INSERT INTO "Challenge" (
    "title", "description", "theme", "invitation",
    "startsAt", "endsAt", "visibleAt",
    "coverImageId", "nsfwLevel", "allowedNsfwLevel",
    "modelVersionIds", "collectionId", "createdById",
    "status", "source",
    "prizes", "entryPrize", "entryPrizeRequirement",
    "prizePool", "operationBudget",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    'Enchanted Forest',
    'Magical forests filled with ancient trees, fairy lights, and mystical creatures.',
    'Fantasy & Nature',
    'Step into the enchanted woods!',
    NOW() - INTERVAL '10 days',
    NOW() - INTERVAL '3 days',
    NOW() - INTERVAL '11 days',
    67134122, 1, 1,
    mv_ids, col6, civchan_id,
    'Completed'::"ChallengeStatus", 'System'::"ChallengeSource",
    prizes_json, entry_prize, 10,
    9000, 5000,
    '{"seed": true}'::jsonb, NOW() - INTERVAL '10 days', NOW() - INTERVAL '3 days'
  ) RETURNING id INTO ch6;

  -- 7. Frozen Realms — Cancelled (was scheduled for +5 days)
  INSERT INTO "Challenge" (
    "title", "description", "theme", "invitation",
    "startsAt", "endsAt", "visibleAt",
    "coverImageId", "nsfwLevel", "allowedNsfwLevel",
    "modelVersionIds", "collectionId", "createdById",
    "status", "source",
    "prizes", "entryPrize", "entryPrizeRequirement",
    "prizePool", "operationBudget",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    'Frozen Realms',
    'Ice kingdoms, frozen waterfalls, and arctic landscapes in stunning detail.',
    'Ice & Winter',
    'Brave the frozen frontier!',
    NOW() + INTERVAL '5 days',
    NOW() + INTERVAL '8 days',
    NOW() + INTERVAL '4 days',
    67821254, 1, 1,
    mv_ids, col7, civbot_id,
    'Cancelled'::"ChallengeStatus", 'System'::"ChallengeSource",
    prizes_json, entry_prize, 10,
    9000, 5000,
    '{"seed": true}'::jsonb, NOW(), NOW()
  ) RETURNING id INTO ch7;

  -- 8. Pixel Pandemonium — Active, started yesterday, ends tomorrow (stress test)
  INSERT INTO "Challenge" (
    "title", "description", "theme", "invitation",
    "startsAt", "endsAt", "visibleAt",
    "coverImageId", "nsfwLevel", "allowedNsfwLevel",
    "modelVersionIds", "collectionId", "createdById",
    "status", "source",
    "prizes", "entryPrize", "entryPrizeRequirement",
    "prizePool", "operationBudget",
    "metadata", "createdAt", "updatedAt"
  ) VALUES (
    'Pixel Pandemonium',
    'Pixel art chaos — retro gaming, glitch art, and digital nostalgia collide.',
    'Pixel Art & Retro',
    'Unleash the pixel madness!',
    NOW() - INTERVAL '1 day',
    NOW() + INTERVAL '1 day',
    NOW() - INTERVAL '2 days',
    67824074, 1, 1,
    mv_ids, col8, civbot_id,
    'Active'::"ChallengeStatus", 'System'::"ChallengeSource",
    prizes_json, entry_prize, 10,
    9000, 5000,
    '{"seed": true}'::jsonb, NOW() - INTERVAL '1 day', NOW()
  ) RETURNING id INTO ch8;

  -- ===========================================================================
  -- Step 3: Insert CollectionItems (entries)
  -- ===========================================================================

  -- -------------------------------------------------------------------------
  -- Challenge 3: Urban Legends — 4 entries (2 ACCEPTED, 2 REVIEW), no scores
  -- -------------------------------------------------------------------------
  INSERT INTO "CollectionItem" ("collectionId", "imageId", "addedById", "status", "tagId", "note", "createdAt", "updatedAt")
  VALUES
    (col3, 102033435, 7601034, 'ACCEPTED'::"CollectionItemStatus", review_tag, NULL, NOW() - INTERVAL '20 hours', NOW()),
    (col3, 102033427, 4909860, 'ACCEPTED'::"CollectionItemStatus", review_tag, NULL, NOW() - INTERVAL '18 hours', NOW()),
    (col3, 102033402, 464019,  'REVIEW'::"CollectionItemStatus",   review_tag, NULL, NOW() - INTERVAL '12 hours', NOW()),
    (col3, 102033401, 4911463, 'REVIEW'::"CollectionItemStatus",   review_tag, NULL, NOW() - INTERVAL '10 hours', NOW());

  -- -------------------------------------------------------------------------
  -- Challenge 4: Crystal Caverns — 5 entries (2 ACCEPTED+judged, 2 ACCEPTED+unscored, 1 REVIEW)
  -- -------------------------------------------------------------------------
  INSERT INTO "CollectionItem" ("collectionId", "imageId", "addedById", "status", "tagId", "note", "createdAt", "updatedAt")
  VALUES
    -- ACCEPTED + judged (scored)
    (col4, 102033384, 3465695, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":8,"wittiness":6,"humor":5,"aesthetic":9},"summary":"Strong thematic crystals with vivid lighting."}',
     NOW() - INTERVAL '40 hours', NOW()),
    (col4, 102033361, 5292392, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":7,"wittiness":7,"humor":6,"aesthetic":8},"summary":"Creative cavern composition with good depth."}',
     NOW() - INTERVAL '38 hours', NOW()),
    -- ACCEPTED + unscored
    (col4, 102033351, 9833382, 'ACCEPTED'::"CollectionItemStatus", review_tag, NULL, NOW() - INTERVAL '30 hours', NOW()),
    (col4, 102033339, 8784251, 'ACCEPTED'::"CollectionItemStatus", review_tag, NULL, NOW() - INTERVAL '28 hours', NOW()),
    -- REVIEW
    (col4, 102033335, 8784251, 'REVIEW'::"CollectionItemStatus",   review_tag, NULL, NOW() - INTERVAL '20 hours', NOW());

  -- -------------------------------------------------------------------------
  -- Challenge 5: Sunset Warriors — 6 entries, all ACCEPTED+judged (ready for winner picking)
  -- -------------------------------------------------------------------------
  INSERT INTO "CollectionItem" ("collectionId", "imageId", "addedById", "status", "tagId", "note", "createdAt", "updatedAt")
  VALUES
    (col5, 102033334, 8784251, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":9,"wittiness":7,"humor":6,"aesthetic":9},"summary":"Epic warrior silhouette against a blazing sunset — top tier."}',
     NOW() - INTERVAL '46 hours', NOW()),
    (col5, 102033333, 8784251, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":8,"wittiness":8,"humor":7,"aesthetic":8},"summary":"Dynamic battle pose with warm golden tones."}',
     NOW() - INTERVAL '44 hours', NOW()),
    (col5, 102033319, 4909860, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":7,"wittiness":6,"humor":5,"aesthetic":7},"summary":"Decent warrior scene, composition could be tighter."}',
     NOW() - INTERVAL '42 hours', NOW()),
    (col5, 102033318, 5292392, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":9,"wittiness":9,"humor":8,"aesthetic":9},"summary":"Outstanding piece — cinematic framing and emotional impact."}',
     NOW() - INTERVAL '40 hours', NOW()),
    (col5, 102033298, 9870609, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":6,"wittiness":5,"humor":4,"aesthetic":6},"summary":"Captures the theme but lacks detail refinement."}',
     NOW() - INTERVAL '38 hours', NOW()),
    (col5, 102033286, 4591913, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":8,"wittiness":7,"humor":6,"aesthetic":8},"summary":"Strong composition with beautiful color grading."}',
     NOW() - INTERVAL '36 hours', NOW());

  -- -------------------------------------------------------------------------
  -- Challenge 6: Enchanted Forest — 3 entries, all ACCEPTED+judged (winners already picked)
  -- -------------------------------------------------------------------------
  INSERT INTO "CollectionItem" ("collectionId", "imageId", "addedById", "status", "tagId", "note", "createdAt", "updatedAt")
  VALUES
    (col6, 102033281, 5292392, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":9,"wittiness":8,"humor":7,"aesthetic":10},"summary":"Masterful enchanted forest with ethereal lighting — clear winner."}',
     NOW() - INTERVAL '8 days', NOW() - INTERVAL '3 days'),
    (col6, 102033275, 7593377, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":8,"wittiness":8,"humor":7,"aesthetic":9},"summary":"Beautiful mystical woodland with excellent atmosphere."}',
     NOW() - INTERVAL '7 days', NOW() - INTERVAL '3 days'),
    (col6, 102033333, 8784251, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":7,"wittiness":7,"humor":6,"aesthetic":8},"summary":"Good fairy-tale forest scene with nice detail work."}',
     NOW() - INTERVAL '6 days', NOW() - INTERVAL '3 days');

  -- -------------------------------------------------------------------------
  -- Challenge 8: Pixel Pandemonium — 18 entries (stress test)
  --   8 ACCEPTED+judged, 5 ACCEPTED+unscored, 3 REVIEW, 2 REJECTED
  -- -------------------------------------------------------------------------
  INSERT INTO "CollectionItem" ("collectionId", "imageId", "addedById", "status", "tagId", "note", "createdAt", "updatedAt")
  VALUES
    -- 8 ACCEPTED + judged
    (col8, 102033435, 7601034, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":9,"wittiness":8,"humor":9,"aesthetic":8},"summary":"Pixel-perfect chaos with retro gaming homage."}',
     NOW() - INTERVAL '23 hours', NOW()),
    (col8, 102033427, 4909860, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":8,"wittiness":7,"humor":8,"aesthetic":7},"summary":"Fun glitch art with strong pixel identity."}',
     NOW() - INTERVAL '22 hours', NOW()),
    (col8, 102033402, 464019,  'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":7,"wittiness":9,"humor":7,"aesthetic":6},"summary":"Witty concept, execution needs refinement."}',
     NOW() - INTERVAL '21 hours', NOW()),
    (col8, 102033401, 4911463, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":8,"wittiness":6,"humor":6,"aesthetic":9},"summary":"Gorgeous pixel art, could use more humor."}',
     NOW() - INTERVAL '20 hours', NOW()),
    (col8, 102033384, 3465695, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":6,"wittiness":8,"humor":8,"aesthetic":7},"summary":"Creative and funny, theme connection is loose."}',
     NOW() - INTERVAL '19 hours', NOW()),
    (col8, 102033361, 5292392, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":9,"wittiness":9,"humor":9,"aesthetic":9},"summary":"Outstanding — captures pixel pandemonium perfectly."}',
     NOW() - INTERVAL '18 hours', NOW()),
    (col8, 102033351, 9833382, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":7,"wittiness":5,"humor":5,"aesthetic":8},"summary":"Strong aesthetics but lacks the pandemonium energy."}',
     NOW() - INTERVAL '17 hours', NOW()),
    (col8, 102033339, 8784251, 'ACCEPTED'::"CollectionItemStatus", judged_tag,
     '{"score":{"theme":8,"wittiness":7,"humor":7,"aesthetic":8},"summary":"Solid all-around pixel art with good energy."}',
     NOW() - INTERVAL '16 hours', NOW()),

    -- 5 ACCEPTED + unscored
    (col8, 102033335, 8784251, 'ACCEPTED'::"CollectionItemStatus", review_tag, NULL, NOW() - INTERVAL '15 hours', NOW()),
    (col8, 102033334, 8784251, 'ACCEPTED'::"CollectionItemStatus", review_tag, NULL, NOW() - INTERVAL '14 hours', NOW()),
    (col8, 102033319, 4909860, 'ACCEPTED'::"CollectionItemStatus", review_tag, NULL, NOW() - INTERVAL '13 hours', NOW()),
    (col8, 102033318, 5292392, 'ACCEPTED'::"CollectionItemStatus", review_tag, NULL, NOW() - INTERVAL '12 hours', NOW()),
    (col8, 102033298, 9870609, 'ACCEPTED'::"CollectionItemStatus", review_tag, NULL, NOW() - INTERVAL '11 hours', NOW()),

    -- 3 REVIEW
    (col8, 102033286, 4591913, 'REVIEW'::"CollectionItemStatus",   review_tag, NULL, NOW() - INTERVAL '10 hours', NOW()),
    (col8, 102033283, 7593377, 'REVIEW'::"CollectionItemStatus",   review_tag, NULL, NOW() - INTERVAL '9 hours',  NOW()),
    (col8, 102033281, 5292392, 'REVIEW'::"CollectionItemStatus",   review_tag, NULL, NOW() - INTERVAL '8 hours',  NOW()),

    -- 2 REJECTED
    (col8, 102033275, 7593377, 'REJECTED'::"CollectionItemStatus", review_tag, NULL, NOW() - INTERVAL '7 hours', NOW()),
    (col8, 102033333, 8784251, 'REJECTED'::"CollectionItemStatus", review_tag, NULL, NOW() - INTERVAL '6 hours', NOW());

  -- ===========================================================================
  -- Step 4: Insert ChallengeWinner records (Challenge 6 — Enchanted Forest)
  -- ===========================================================================
  INSERT INTO "ChallengeWinner" (
    "challengeId", "userId", "imageId", "place",
    "buzzAwarded", "pointsAwarded", "reason", "createdAt"
  ) VALUES
    (ch6, 5292392, 102033281, 1, 5000, 150,
     'Masterful enchanted forest with ethereal lighting — clear winner.',
     NOW() - INTERVAL '3 days'),
    (ch6, 7593377, 102033275, 2, 2500, 100,
     'Beautiful mystical woodland with excellent atmosphere.',
     NOW() - INTERVAL '3 days'),
    (ch6, 8784251, 102033333, 3, 1500, 50,
     'Good fairy-tale forest scene with nice detail work.',
     NOW() - INTERVAL '3 days');

  -- ===========================================================================
  -- Done — report summary
  -- ===========================================================================
  RAISE NOTICE '✓ Seed complete: 8 challenges, 8 collections, 36 entries, 3 winners';
  RAISE NOTICE '  Challenge IDs: %, %, %, %, %, %, %, %', ch1, ch2, ch3, ch4, ch5, ch6, ch7, ch8;
  RAISE NOTICE '  Collection IDs: %, %, %, %, %, %, %, %', col1, col2, col3, col4, col5, col6, col7, col8;

END $$;

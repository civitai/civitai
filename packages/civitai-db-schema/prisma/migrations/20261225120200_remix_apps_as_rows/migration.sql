-- Remix apps as data: the system remix apps become `app_blocks` rows that moderators edit at
-- /moderator/remix-apps, so adding or changing one needs no deploy.
--
-- DATA ONLY: no schema change. Inserts
--   1. the OAuth client the rows belong to (`app_blocks.app_id` is a required FK). It cannot be
--      used to sign in or mint a token: no secret, no redirect URIs, no grants, no scopes, and
--      access mode 'disabled'. Owner: the civitai system account (User id -1).
--   2. one row per current system app, in menu order (`featured_order`). The manifests are
--      `SEED_REMIX_APPS` (src/shared/remix-apps/seed.ts) rendered through `manifestOf`;
--      `remix-app-seed.test.ts` fails if this file and the seed differ.
--
-- status is 'remix' (listed) or 'remix_disabled', never 'approved', so no App Blocks read that
-- serves third-party apps (store, token mint, health, analytics) sees these rows.
--
-- Until this runs, the registry finds no rows and serves the same apps from the seed constants,
-- so it can be applied before or after the deploy. Once it runs, a server may keep serving the
-- seed (the same apps) from a cached empty read for up to an hour; the first mod write recaches
-- the rows at once.
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING, so re-applying never overwrites a mod's edits.
--
-- Row ids are remixAppBlockRowId(slug): app_blocks_id_length_check holds ids to 28-40 chars.
--
-- MANUAL APPLY, per writable env, after 20261225120130 and 20261225120140 (the status CHECK
-- rejects 'remix' without them):
--   0. Pre-check (read-only role). All must hold, or the guarded inserts skip rows silently:
--      a. no remix row exists yet:  SELECT count(*) FROM app_blocks WHERE block_id LIKE 'remix-%';  -> 0
--      b. the owner exists:         SELECT count(*) FROM "User" WHERE id = -1;                      -> 1
--      c. the status CHECK allows remix, validated:
--           SELECT count(*) FROM pg_constraint WHERE conname = 'app_blocks_status_check'
--             AND convalidated AND pg_get_constraintdef(oid) LIKE '%remix_disabled%';                -> 1
--   1. Dry run: this file inside BEGIN; ... ROLLBACK;
--   2. Apply.
--   3. Scoped drift check (read-only role):
--        pnpm --filter @civitai/db-schema drift --migration prisma/migrations/20261225120200_remix_apps_as_rows/migration.sql
--   4. After-read (read-only role):
--        SELECT count(*) FROM "OauthClient" WHERE id = 'civitai-remix-apps' AND "accessMode" = 'disabled';  -> 1
--        SELECT count(*) FROM app_blocks WHERE status = 'remix';                                         -> 8
INSERT INTO "OauthClient" (
  "id",
  "secret",
  "name",
  "description",
  "redirectUris",
  "allowedOrigins",
  "grants",
  "allowedScopes",
  "isConfidential",
  "accessMode",
  "userId",
  "isVerified"
)
SELECT
  'civitai-remix-apps',
  NULL,
  'Civitai Remix Apps',
  'Owner of the system remix app rows. Not a sign-in client.',
  ARRAY[]::TEXT[],
  ARRAY[]::TEXT[],
  ARRAY[]::TEXT[],
  0,
  true,
  'disabled',
  -1,
  true
WHERE EXISTS (SELECT 1 FROM "User" WHERE "id" = -1)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "app_blocks" ("id", "app_id", "block_id", "version", "manifest", "status", "content_rating", "featured_order")
SELECT v.id, 'civitai-remix-apps', v.block_id, v.version, v.manifest, 'remix', v.content_rating, v.featured_order
FROM (VALUES
  ('ab_rx_anime_it______________', 'remix-anime-it', '1.0.0', $json${"kind":"remix","name":"Anime it","version":"1.0.0","targets":[{"slotId":"image.remix"}],"remix":{"icon":"sparkles","engine":{"safe":{"ecosystem":"NanoBanana","versionId":3086021},"mature":{"ecosystem":"Qwen","versionId":2558804}},"asks":[],"steps":[{"kind":"image","prompt":"Redraw this image as a 2D anime illustration with clean black line art, flat cel shading with hard-edged shadow shapes, and simple flat colors. If the source is a photo or a 3D render, convert every surface into hand-drawn anime style, with no photographic texture and no realistic rendering. Keep the subject, pose and composition. Don't add any text or lettering.","aspectRatio":"source","quantity":1,"input":"source"}]}}$json$::jsonb, 'x', 0),
  ('ab_rx_pick_of_four__________', 'remix-pick-of-four', '1.0.0', $json${"kind":"remix","name":"Pick of four","description":"Four takes on this image. Keep your favourite, or upscale it.","version":"1.0.0","targets":[{"slotId":"image.remix"}],"remix":{"icon":"pick","code":"pick-of-four"}}$json$::jsonb, 'x', 1),
  ('ab_rx_restyle_______________', 'remix-restyle', '1.0.0', $json${"kind":"remix","name":"Restyle","description":"Pick a style, and add something to the scene if you like.","version":"1.0.0","targets":[{"slotId":"image.remix"}],"remix":{"icon":"palette","engine":{"safe":{"ecosystem":"NanoBanana","versionId":3086021},"mature":{"ecosystem":"Qwen","versionId":2558804}},"asks":[{"id":"extra","kind":"text","prompt":"Add something to the scene (optional)","maxLength":120,"optional":true,"wrap":{"before":" Also add to the scene: ","after":"."}},{"id":"style","kind":"choice","prompt":"Pick a style","options":[{"value":"watercolor","label":"Watercolor","fragments":{"look":"a loose watercolor painting on textured paper, with soft washes and visible brush edges","noText":"Don't add any text or lettering."}},{"value":"oil-painting","label":"Oil painting","fragments":{"look":"a classical oil painting on canvas, with rich colour and visible brushstrokes","noText":"Don't add any text or lettering."}},{"value":"ukiyo-e","label":"Ukiyo-e","fragments":{"look":"a Japanese ukiyo-e woodblock print, with flat colour, bold outlines and paper grain","noText":"Don't add any text, lettering, seals or stamps."}},{"value":"cyberpunk-neon","label":"Cyberpunk neon","fragments":{"look":"a cyberpunk night scene lit by neon signs, with magenta and cyan glow and wet reflections","noText":"Don't add any text or lettering."}},{"value":"claymation","label":"Claymation","fragments":{"look":"a stop-motion claymation scene, with plasticine figures and fingerprint texture","noText":"Don't add any text or lettering."}}]}],"steps":[{"kind":"image","prompt":"Restyle this image as {{look}}. Keep the subject, their pose and the composition the same.{{extra}} {{noText}}","aspectRatio":"source","quantity":1,"input":"source"}]}}$json$::jsonb, 'x', 2),
  ('ab_rx_make_it_real__________', 'remix-make-it-real', '1.0.0', $json${"kind":"remix","name":"Make it real","version":"1.0.0","targets":[{"slotId":"image.remix"}],"remix":{"icon":"camera","engine":{"safe":{"ecosystem":"NanoBanana","versionId":3086021},"mature":{"ecosystem":"Qwen","versionId":2558804}},"asks":[],"steps":[{"kind":"image","prompt":"Turn this image into a live-action photograph of the real person (or the real animal or object) shown, in the same outfit, pose and setting, as if shot on a DSLR in natural light: real skin, hair, fabric and materials, and real surroundings. Nothing may look drawn, painted or rendered, with no line art, no cel shading and no glossy anime eyes. Keep the pose, outfit and composition. Don't add any text or lettering.","aspectRatio":"source","quantity":1,"input":"source"}]}}$json$::jsonb, 'x', 3),
  ('ab_rx_toy_figure____________', 'remix-toy-figure', '1.0.0', $json${"kind":"remix","name":"Toy figure","version":"1.0.0","targets":[{"slotId":"image.remix"}],"remix":{"icon":"toy","engine":{"safe":{"ecosystem":"NanoBanana","versionId":3086021},"mature":{"ecosystem":"Qwen","versionId":2558804}},"asks":[],"steps":[{"kind":"image","prompt":"Turn the subject into a collectible toy figure in its packaging box, product photo. Don't add any text or lettering.","aspectRatio":"source","quantity":1,"input":"source"}]}}$json$::jsonb, 'x', 4),
  ('ab_rx_pixel_art_____________', 'remix-pixel-art', '1.0.0', $json${"kind":"remix","name":"Pixel art","version":"1.0.0","targets":[{"slotId":"image.remix"}],"remix":{"icon":"grid","engine":{"safe":{"ecosystem":"NanoBanana","versionId":3086021},"mature":{"ecosystem":"Qwen","versionId":2558804}},"asks":[],"steps":[{"kind":"image","prompt":"Redraw this image as true low-resolution pixel art, as if drawn on a 160 by 240 pixel grid and scaled up with nearest-neighbor: large, clearly visible square pixels, hard stair-stepped edges, no anti-aliasing or smooth gradients, and a limited palette of about 16 flat colors with simple dithering. Keep the subject, pose and composition. Don't add any text or lettering.","aspectRatio":"source","quantity":1,"input":"source"}]}}$json$::jsonb, 'x', 5),
  ('ab_rx_pencil_sketch_________', 'remix-pencil-sketch', '1.0.0', $json${"kind":"remix","name":"Pencil sketch","version":"1.0.0","targets":[{"slotId":"image.remix"}],"remix":{"icon":"pencil","engine":{"safe":{"ecosystem":"NanoBanana","versionId":3086021},"mature":{"ecosystem":"Qwen","versionId":2558804}},"asks":[],"steps":[{"kind":"image","prompt":"Redraw this image as a detailed graphite pencil sketch on paper. Don't add any text or lettering.","aspectRatio":"source","quantity":1,"input":"source"}]}}$json$::jsonb, 'x', 6),
  ('ab_rx_claymation____________', 'remix-claymation', '1.0.0', $json${"kind":"remix","name":"Claymation","version":"1.0.0","targets":[{"slotId":"image.remix"}],"remix":{"icon":"clay","engine":{"safe":{"ecosystem":"NanoBanana","versionId":3086021},"mature":{"ecosystem":"Qwen","versionId":2558804}},"asks":[],"steps":[{"kind":"image","prompt":"Recreate this image as a stop-motion claymation scene with plasticine figures. Don't add any text or lettering.","aspectRatio":"source","quantity":1,"input":"source"}]}}$json$::jsonb, 'x', 7)
) AS v(id, block_id, version, manifest, content_rating, featured_order)
WHERE EXISTS (SELECT 1 FROM "OauthClient" WHERE "id" = 'civitai-remix-apps')
ON CONFLICT DO NOTHING;
